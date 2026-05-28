#!/usr/bin/env node

import { spawn, execSync } from 'child_process';
import chalk from 'chalk';
import { Keypair } from '@stellar/stellar-sdk';

interface TestResult {
  test: string;
  passed: boolean;
  error?: string;
  duration?: number;
}

class StressTest {
  private results: TestResult[] = [];
  private relayerProcess: any = null;
  private readonly relayerUrl = 'http://localhost:3000';

  async run() {
    console.log(chalk.cyan('🚀 Starting Stellar Stealth Stress Test\n'));

    try {
      await this.setup();
      await this.runTests();
      this.printResults();
    } catch (error: any) {
      console.error(chalk.red('Fatal error:'), error.message);
      process.exit(1);
    } finally {
      await this.cleanup();
    }
  }

  private async setup() {
    console.log(chalk.cyan('📋 Setting up test environment...\n'));

    console.log('1. Checking Docker local network...');
    try {
      execSync('docker ps | grep stellar', { stdio: 'ignore' });
      console.log(chalk.green('   ✓ Local Stellar network is running'));
    } catch {
      console.log(chalk.yellow('   ⚠ Starting local Stellar network...'));
      execSync('docker compose up -d', { stdio: 'inherit' });
      await this.sleep(5000);
    }

    console.log('2. Building packages...');
    execSync('npm run build', { stdio: 'ignore' });
    console.log(chalk.green('   ✓ Packages built'));

    console.log('3. Starting relayer...');
    this.relayerProcess = spawn('npm', ['run', 'relayer:dev'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: '3000', NETWORK: 'local' },
      detached: false
    });

    await this.sleep(3000);
    await this.waitForRelayer();
    console.log(chalk.green('   ✓ Relayer is running'));

    console.log('4. Creating test accounts...');
    const alice = Keypair.random();
    const bob = Keypair.random();

    await this.fundAccount(alice.publicKey());
    await this.fundAccount(bob.publicKey());

    process.env.TEST_ALICE_SECRET = alice.secret();
    process.env.TEST_BOB_SECRET = bob.secret();

    console.log(chalk.green('   ✓ Test accounts funded\n'));
  }

  private async runTests() {
    console.log(chalk.cyan('🧪 Running stress tests...\n'));

    await this.testKeygen();
    await this.testRapidSendCycle();
    await this.testRateLimiting();
    await this.testErrorHandling();
    await this.testRelayerRestart();
    await this.testConcurrentOperations();
    await this.testVerboseMode();
  }

  private async testKeygen() {
    const test = 'Key generation';
    console.log(chalk.gray(`Running: ${test}...`));
    const start = Date.now();

    try {
      execSync('npx stealth keygen --force', { stdio: 'ignore' });
      const duration = Date.now() - start;
      this.results.push({ test, passed: true, duration });
      console.log(chalk.green(`✓ ${test} (${duration}ms)`));
    } catch (error: any) {
      this.results.push({ test, passed: false, error: error.message });
      console.log(chalk.red(`✗ ${test}: ${error.message}`));
    }
  }

  private async testRapidSendCycle() {
    const test = 'Rapid send→scan→withdraw cycle (10 iterations)';
    console.log(chalk.gray(`Running: ${test}...`));
    const start = Date.now();

    try {
      const aliceSecret = process.env.TEST_ALICE_SECRET!;

      for (let i = 0; i < 10; i++) {
        const metaAddress = execSync('npx stealth keygen --show', { encoding: 'utf8' }).trim();

        execSync(
          `npx stealth send "${metaAddress}" 1 --from ${aliceSecret} --relay ${this.relayerUrl}`,
          { stdio: 'ignore' }
        );

        const scanOutput = execSync('npx stealth scan', { encoding: 'utf8' });
        if (!scanOutput.includes('stealth address')) {
          throw new Error('Scan failed to find stealth address');
        }

        const stealthMatch = scanOutput.match(/G[A-Z0-9]+/);
        if (stealthMatch) {
          execSync(
            `npx stealth withdraw ${stealthMatch[0]} --to ${aliceSecret.substring(0, 56)}`,
            { stdio: 'ignore' }
          );
        }

        await this.sleep(100);
      }

      const duration = Date.now() - start;
      this.results.push({ test, passed: true, duration });
      console.log(chalk.green(`✓ ${test} (${duration}ms)`));
    } catch (error: any) {
      this.results.push({ test, passed: false, error: error.message });
      console.log(chalk.red(`✗ ${test}: ${error.message}`));
    }
  }

  private async testRateLimiting() {
    const test = 'Rate limiting (15 rapid requests)';
    console.log(chalk.gray(`Running: ${test}...`));
    const start = Date.now();

    try {
      let rateLimited = false;

      for (let i = 0; i < 15; i++) {
        const address = Keypair.random().publicKey();
        const response = await fetch(`${this.relayerUrl}/sponsor`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address })
        });

        if (response.status === 429) {
          rateLimited = true;
          break;
        }
      }

      if (!rateLimited) {
        throw new Error('Rate limiting did not trigger');
      }

      const duration = Date.now() - start;
      this.results.push({ test, passed: true, duration });
      console.log(chalk.green(`✓ ${test} (${duration}ms)`));
    } catch (error: any) {
      this.results.push({ test, passed: false, error: error.message });
      console.log(chalk.red(`✗ ${test}: ${error.message}`));
    }
  }

  private async testErrorHandling() {
    const test = 'Error handling (invalid inputs)';
    console.log(chalk.gray(`Running: ${test}...`));
    const start = Date.now();

    try {
      try {
        execSync('npx stealth send invalid:address 1 --from test', { stdio: 'ignore' });
        throw new Error('Should have failed on invalid meta-address');
      } catch (error: any) {
        if (!error.message.includes('Invalid meta-address format')) {
          throw error;
        }
      }

      try {
        execSync('npx stealth send valid:valid -5 --from test', { stdio: 'ignore' });
        throw new Error('Should have failed on negative amount');
      } catch (error: any) {
        if (!error.message.includes('Invalid amount')) {
          throw error;
        }
      }

      const duration = Date.now() - start;
      this.results.push({ test, passed: true, duration });
      console.log(chalk.green(`✓ ${test} (${duration}ms)`));
    } catch (error: any) {
      this.results.push({ test, passed: false, error: error.message });
      console.log(chalk.red(`✗ ${test}: ${error.message}`));
    }
  }

  private async testRelayerRestart() {
    const test = 'Relayer restart recovery';
    console.log(chalk.gray(`Running: ${test}...`));
    const start = Date.now();

    try {
      console.log(chalk.gray('   Stopping relayer...'));
      if (this.relayerProcess) {
        this.relayerProcess.kill('SIGTERM');
        await this.sleep(2000);
      }

      console.log(chalk.gray('   Restarting relayer...'));
      this.relayerProcess = spawn('npm', ['run', 'relayer:dev'], {
        cwd: process.cwd(),
        env: { ...process.env, PORT: '3000', NETWORK: 'local' },
        detached: false
      });

      await this.sleep(3000);
      await this.waitForRelayer();

      const response = await fetch(`${this.relayerUrl}/health`);
      if (!response.ok) {
        throw new Error('Relayer health check failed after restart');
      }

      const duration = Date.now() - start;
      this.results.push({ test, passed: true, duration });
      console.log(chalk.green(`✓ ${test} (${duration}ms)`));
    } catch (error: any) {
      this.results.push({ test, passed: false, error: error.message });
      console.log(chalk.red(`✗ ${test}: ${error.message}`));
    }
  }

  private async testConcurrentOperations() {
    const test = 'Concurrent operations (5 parallel sends)';
    console.log(chalk.gray(`Running: ${test}...`));
    const start = Date.now();

    try {
      const aliceSecret = process.env.TEST_ALICE_SECRET!;
      const metaAddress = execSync('npx stealth keygen --show', { encoding: 'utf8' }).trim();

      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(new Promise((resolve, reject) => {
          execSync(
            `npx stealth send "${metaAddress}" 0.5 --from ${aliceSecret} --relay ${this.relayerUrl}`,
            { stdio: 'ignore' },
            (error: any) => {
              if (error) reject(error);
              else resolve(true);
            }
          );
        }));
      }

      await Promise.all(promises);

      const duration = Date.now() - start;
      this.results.push({ test, passed: true, duration });
      console.log(chalk.green(`✓ ${test} (${duration}ms)`));
    } catch (error: any) {
      this.results.push({ test, passed: false, error: error.message });
      console.log(chalk.red(`✗ ${test}: ${error.message}`));
    }
  }

  private async testVerboseMode() {
    const test = 'Verbose mode output';
    console.log(chalk.gray(`Running: ${test}...`));
    const start = Date.now();

    try {
      const aliceSecret = process.env.TEST_ALICE_SECRET!;
      const metaAddress = execSync('npx stealth keygen --show', { encoding: 'utf8' }).trim();

      const output = execSync(
        `npx stealth send "${metaAddress}" 1 --from ${aliceSecret} --relay ${this.relayerUrl} --verbose`,
        { encoding: 'utf8' }
      );

      if (!output.includes('Transaction hash:') || !output.includes('Fee:')) {
        throw new Error('Verbose mode not showing expected details');
      }

      const duration = Date.now() - start;
      this.results.push({ test, passed: true, duration });
      console.log(chalk.green(`✓ ${test} (${duration}ms)`));
    } catch (error: any) {
      this.results.push({ test, passed: false, error: error.message });
      console.log(chalk.red(`✗ ${test}: ${error.message}`));
    }
  }

  private printResults() {
    console.log(chalk.cyan('\n📊 Test Results:\n'));

    const passed = this.results.filter(r => r.passed).length;
    const failed = this.results.filter(r => !r.passed).length;
    const totalDuration = this.results.reduce((acc, r) => acc + (r.duration || 0), 0);

    this.results.forEach(result => {
      const icon = result.passed ? chalk.green('✓') : chalk.red('✗');
      const duration = result.duration ? chalk.gray(` (${result.duration}ms)`) : '';
      console.log(`${icon} ${result.test}${duration}`);
      if (result.error) {
        console.log(chalk.red(`  Error: ${result.error}`));
      }
    });

    console.log('\n' + chalk.gray('─'.repeat(50)));
    console.log(chalk.cyan('Total:'), `${passed} passed, ${failed} failed`);
    console.log(chalk.cyan('Duration:'), `${totalDuration}ms`);

    if (failed > 0) {
      console.log(chalk.red('\n❌ Some tests failed'));
      process.exit(1);
    } else {
      console.log(chalk.green('\n✅ All tests passed!'));
    }
  }

  private async cleanup() {
    console.log(chalk.gray('\n🧹 Cleaning up...'));

    if (this.relayerProcess) {
      this.relayerProcess.kill('SIGTERM');
      await this.sleep(1000);
    }

    console.log(chalk.green('✓ Cleanup complete'));
  }

  private async waitForRelayer(maxRetries = 30) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch(`${this.relayerUrl}/health`);
        if (response.ok) return;
      } catch {}
      await this.sleep(1000);
    }
    throw new Error('Relayer failed to start');
  }

  private async fundAccount(publicKey: string) {
    const response = await fetch(`http://localhost:8000/friendbot?addr=${publicKey}`);
    if (!response.ok) {
      throw new Error(`Failed to fund account ${publicKey}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

const test = new StressTest();
test.run().catch(console.error);