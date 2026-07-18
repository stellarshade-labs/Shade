import { describe, it, expect } from 'vitest';
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { planBumpFee } from './relayFee.js';

const kp = Keypair.random();

/** A real classic tx with `nOps` payments and an exact TOTAL fee (stroops). */
function classicTx(nOps: number, totalFee: number): Transaction {
  const source = new Account(Keypair.random().publicKey(), '0');
  const b = new TransactionBuilder(source, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  });
  for (let i = 0; i < nOps; i++) {
    b.addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    );
  }
  const tx = b.setTimeout(300).build();
  // The builder only takes a per-op fee; set the exact (possibly non-divisible)
  // total on the envelope to exercise the ceil-division path.
  const env = tx.toEnvelope();
  env.v1().tx().fee(totalFee);
  return new Transaction(env, Networks.TESTNET);
}

/** A real Soroban-shaped tx: 1 op, per-op inclusion fee + a resource fee. */
function sorobanTx(inclusionPerOp: string, resourceFee: number): Transaction {
  const source = new Account(Keypair.random().publicKey(), '0');
  return new TransactionBuilder(source, {
    fee: inclusionPerOp,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setSorobanData(new SorobanDataBuilder().setResourceFee(resourceFee).build())
    .setTimeout(300)
    .build();
}

describe('planBumpFee', () => {
  it.each([
    // [nOps, totalFee, expected bumpBase with clamped base 100]
    [1, 100, 200n], // inner at the floor: doubled network base wins
    [3, 300, 200n], // divisible per-op (100) under the doubled base
    [3, 900, 300n], // divisible per-op (300) above the doubled base
    [3, 1201, 401n], // NON-divisible: exact rational 400.33 -> ceil 401
    [5, 1, 200n], // ceil(1/5) = 1, doubled base wins
    [1, 2000000, 2000000n], // the observed e2e 500-case: inner demand wins
  ])(
    'matches the SDK build exactly for %i ops, inner fee %i',
    (nOps, totalFee, expectedBase) => {
      const inner = classicTx(nOps, totalFee);
      const plan = planBumpFee(inner, 100)!;
      expect(plan).not.toBeNull();
      expect(plan.bumpBase).toBe(expectedBase);
      // Building with the planned base must not throw, and must produce
      // EXACTLY the planned outer fee — the executable proof that the
      // precompute mirrors the SDK's fee math.
      const built = TransactionBuilder.buildFeeBumpTransaction(
        kp,
        plan.bumpBase.toString(),
        inner,
        Networks.TESTNET,
      );
      expect(BigInt(built.fee)).toBe(plan.outerFee);
      expect(plan.outerFee).toBe(plan.bumpBase * BigInt(nOps + 1));
    },
  );

  it('computes the minimal base: one stroop less makes the SDK throw', () => {
    // 1201 / 3 ops = 400.33... rationally; the plan says 401. 400 must be
    // rejected by the SDK, proving the ceil is not an over-estimate hiding an
    // off-by-one in either direction.
    const inner = classicTx(3, 1201);
    const plan = planBumpFee(inner, 100)!;
    expect(plan.bumpBase).toBe(401n);
    expect(() =>
      TransactionBuilder.buildFeeBumpTransaction(kp, '400', inner, Networks.TESTNET),
    ).toThrow(/Invalid baseFee/);
  });

  it('excludes the Soroban resource fee from the per-op inclusion demand', () => {
    // The exact shape of the verified e2e pool withdraw: inclusion 200 +
    // resourceFee 31209 => inner fee 31409, planned outer 200×2 + 31209 = 31609
    // (the observed on-chain built fee). Treating the whole 31409 as inclusion
    // would wrongly demand a 31409 bump base and bid a needlessly high fee.
    const inner = sorobanTx('200', 31209);
    expect(inner.fee).toBe('31409');
    const plan = planBumpFee(inner, 100)!;
    expect(plan.bumpBase).toBe(200n);
    expect(plan.outerFee).toBe(31609n);
    const built = TransactionBuilder.buildFeeBumpTransaction(
      kp,
      plan.bumpBase.toString(),
      inner,
      Networks.TESTNET,
    );
    expect(BigInt(built.fee)).toBe(31609n);
  });

  it('scales the doubled base with the clamped network base fee', () => {
    const inner = classicTx(2, 200);
    const plan = planBumpFee(inner, 5000)!;
    expect(plan.bumpBase).toBe(10000n);
    expect(plan.outerFee).toBe(30000n);
  });

  it('enforces the SDK minimum base fee of 100', () => {
    const inner = classicTx(1, 100);
    const plan = planBumpFee(inner, 10)!;
    expect(plan.bumpBase).toBe(100n);
    const built = TransactionBuilder.buildFeeBumpTransaction(
      kp,
      plan.bumpBase.toString(),
      inner,
      Networks.TESTNET,
    );
    expect(BigInt(built.fee)).toBe(plan.outerFee);
  });

  it('returns null for unplannable inputs instead of throwing', () => {
    expect(planBumpFee({ operations: [] } as unknown as Transaction, 100)).toBeNull();
    expect(
      planBumpFee({ operations: [{}], fee: 'garbage' } as unknown as Transaction, 100),
    ).toBeNull();
    expect(planBumpFee({} as unknown as Transaction, 100)).toBeNull();
  });

  it('tolerates test doubles without an envelope (resource fee 0)', () => {
    const plan = planBumpFee(
      { operations: [{}], fee: '600' } as unknown as Transaction,
      100,
    )!;
    expect(plan).not.toBeNull();
    expect(plan.bumpBase).toBe(600n);
    expect(plan.outerFee).toBe(1200n);
  });
});
