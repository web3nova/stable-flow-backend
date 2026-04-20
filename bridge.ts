import { CdpClient } from "@coinbase/cdp-sdk";
import { parseEther, isAddress } from "viem";
import dotenv from "dotenv";

dotenv.config();

// ============================================
// SECURITY CONFIGURATION
// ============================================

const SECURITY_CONFIG = {
  MAX_TRANSACTION_VALUE: parseEther("1"), // Maximum 1 ETH per transaction
  TRANSACTION_TIMEOUT: 200000, // 5 minutes timeout
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000, // 2 seconds
  ALLOWED_NETWORKS: ["base-sepolia", "base-mainnet","mainnet"] as const,
  RATE_LIMIT: {
    maxRequests: 10,
    windowMs: 60000, // 1 minute
  },
};

// ============================================
// VALIDATION FUNCTIONS
// ============================================

class SecurityValidator {
  private static rateLimitTracker = new Map<string, { count: number; resetTime: number }>();

  /**
   * Validate environment variables
   */
  static validateEnvironment(): void {
    const requiredVars = ["CDP_API_KEY", "CDP_PRIVATE_KEY"];
    const missing = requiredVars.filter((varName) => !process.env[varName]);

    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
    }

    // Validate API key format (basic check)
    if (process.env.CDP_API_KEY && process.env.CDP_API_KEY.length < 32) {
      throw new Error("CDP_API_KEY appears to be invalid (too short)");
    }
  }

  /**
   * Validate address format
   */
  static validateAddress(address: string, label: string): void {
    if (!address) {
      throw new Error(`${label} address is required`);
    }
    if (!isAddress(address)) {
      throw new Error(`${label} address is invalid: ${address}`);
    }
    // Check for zero address
    if (address.toLowerCase() === "0x0000000000000000000000000000000000000000") {
      console.warn(`Warning: ${label} is the zero address`);
    }
  }

  /**
   * Validate transaction value
   */
  static validateTransactionValue(value: bigint): void {
    if (value < 0n) {
      throw new Error("Transaction value cannot be negative");
    }
    if (value > SECURITY_CONFIG.MAX_TRANSACTION_VALUE) {
      throw new Error(
        `Transaction value ${value} exceeds maximum allowed: ${SECURITY_CONFIG.MAX_TRANSACTION_VALUE}`
      );
    }
  }

  /**
   * Validate network
   */
  static validateNetwork(network: string): void {
    if (!SECURITY_CONFIG.ALLOWED_NETWORKS.includes(network as any)) {
      throw new Error(
        `Network ${network} not allowed. Allowed networks: ${SECURITY_CONFIG.ALLOWED_NETWORKS.join(", ")}`
      );
    }
  }

  /**
   * Rate limiting check
   */
  static checkRateLimit(identifier: string): void {
    const now = Date.now();
    const tracker = this.rateLimitTracker.get(identifier);

    if (!tracker || now > tracker.resetTime) {
      // Reset or initialize
      this.rateLimitTracker.set(identifier, {
        count: 1,
        resetTime: now + SECURITY_CONFIG.RATE_LIMIT.windowMs,
      });
      return;
    }

    if (tracker.count >= SECURITY_CONFIG.RATE_LIMIT.maxRequests) {
      const waitTime = Math.ceil((tracker.resetTime - now) / 1000);
      throw new Error(`Rate limit exceeded. Please wait ${waitTime} seconds`);
    }

    tracker.count++;
  }

  /**
   * Sanitize transaction data
   */
  static sanitizeData(data: string): string {
    if (!data.startsWith("0x")) {
      throw new Error("Transaction data must start with 0x");
    }
    // Remove any whitespace
    return data.trim();
  }
}

// ============================================
// RETRY LOGIC WITH EXPONENTIAL BACKOFF
// ============================================

async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries: number = SECURITY_CONFIG.MAX_RETRIES
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[${operationName}] Attempt ${attempt}/${maxRetries}`);
      return await operation();
    } catch (error) {
      lastError = error as Error;
      console.error(`[${operationName}] Attempt ${attempt} failed:`, error);

      if (attempt < maxRetries) {
        const delay = SECURITY_CONFIG.RETRY_DELAY * Math.pow(2, attempt - 1);
        console.log(`Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(
    `${operationName} failed after ${maxRetries} attempts: ${lastError?.message}`
  );
}

// ============================================
// SECURE TRANSACTION BUILDER
// ============================================

interface SecureCall {
  to: string;
  value: bigint;
  data: string;
}

class SecureTransactionBuilder {
  private calls: SecureCall[] = [];

  addCall(to: string, value: bigint, data: string): this {
    // Validate each parameter
    SecurityValidator.validateAddress(to, "Recipient");
    SecurityValidator.validateTransactionValue(value);
    const sanitizedData = SecurityValidator.sanitizeData(data);

    this.calls.push({ to, value, data: sanitizedData });
    return this;
  }

  build(): SecureCall[] {
    if (this.calls.length === 0) {
      throw new Error("No calls added to transaction");
    }
    return [...this.calls]; // Return copy to prevent modification
  }

  reset(): void {
    this.calls = [];
  }
}

// ============================================
// MAIN SECURE EXECUTION
// ============================================

async function executeSecureTransaction() {
  console.log("🔒 Starting secure transaction execution...\n");

  try {
    // Step 1: Validate environment
    console.log("✅ Step 1: Validating environment...");
    SecurityValidator.validateEnvironment();
    console.log("   Environment validated successfully\n");

    // Step 2: Initialize CDP client
    console.log("✅ Step 2: Initializing CDP client...");
    const cdp = new CdpClient();
    console.log("   CDP client initialized\n");

    // Step 3: Create owner account with retry
    console.log("✅ Step 3: Creating owner account...");
    const owner = await withRetry(
      async () => await cdp.evm.createAccount({}),
      "Create Owner Account"
    );
    console.log("   Created owner account:", owner.address);
    SecurityValidator.validateAddress(owner.address, "Owner");
    console.log("   Owner address validated\n");

    // Step 4: Create smart account with retry
    console.log("✅ Step 4: Creating smart account...");
    const smartAccount = await withRetry(
      async () => await cdp.evm.createSmartAccount({ owner }),
      "Create Smart Account"
    );
    console.log("   Created smart account:", smartAccount.address);
    SecurityValidator.validateAddress(smartAccount.address, "Smart Account");
    console.log("   Smart account address validated\n");

    // Step 5: Build secure transaction
    console.log("✅ Step 5: Building secure transaction...");
    const network = "base-sepolia";
    SecurityValidator.validateNetwork(network);

    const txBuilder = new SecureTransactionBuilder();
    txBuilder.addCall(
      "0x0000000000000000000000000000000000000000", // Recipient address
      parseEther("0"), // Value in ETH
      "0x" // Transaction data
    );

    const calls = txBuilder.build();
    console.log(`   Built ${calls.length} secure call(s)\n`);

    // Step 6: Rate limiting check
    console.log("✅ Step 6: Checking rate limits...");
    SecurityValidator.checkRateLimit(smartAccount.address);
    console.log("   Rate limit check passed\n");

    // Step 7: Send user operation with timeout
    console.log("✅ Step 7: Sending user operation...");
    const sendPromise = withRetry(
      async () =>
        await cdp.evm.sendUserOperation({
          smartAccount,
          network,
          calls,
        }),
      "Send User Operation"
    );

    // Add timeout protection
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Transaction timeout")),
        SECURITY_CONFIG.TRANSACTION_TIMEOUT
      )
    );

    const result = await Promise.race([sendPromise, timeoutPromise]);
    console.log("   User operation status:", result.status);
    console.log("   User operation hash:", result.userOpHash, "\n");

    // Step 8: Wait for confirmation
    console.log("✅ Step 8: Waiting for confirmation...");
    const userOperation = await withRetry(
      async () =>
        await cdp.evm.waitForUserOperation({
          smartAccountAddress: smartAccount.address,
          userOpHash: result.userOpHash,
        }),
      "Wait for User Operation"
    );

    // Step 9: Verify final status
    console.log("✅ Step 9: Verifying transaction status...");
    if (userOperation.status === "complete") {
      const explorerLink = `https://sepolia.basescan.org/tx/${userOperation.transactionHash}`;
      console.log("   ✅ Transaction confirmed successfully!");
      console.log("   Block explorer link:", explorerLink);
      console.log("   Transaction hash:", userOperation.transactionHash);

      return {
        success: true,
        transactionHash: userOperation.transactionHash,
        explorerLink,
        smartAccountAddress: smartAccount.address,
        ownerAddress: owner.address,
      };
    } else {
      throw new Error(`Transaction failed with status: ${userOperation.status}`);
    }
  } catch (error) {
    console.error("\n❌ Transaction failed with error:");
    console.error(error);

    // Log error details for debugging (but sanitize sensitive info)
    if (error instanceof Error) {
      console.error("Error name:", error.name);
      console.error("Error message:", error.message);
      // Don't log stack trace in production
      if (process.env.NODE_ENV !== "production") {
        console.error("Stack trace:", error.stack);
      }
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  } finally {
    console.log("\n🔒 Transaction execution completed");
  }
}

// ============================================
// EXECUTION WITH ERROR HANDLING
// ============================================

(async () => {
  try {
    const result = await executeSecureTransaction();
    
    if (result.success) {
      console.log("\n✨ Transaction successful!");
      process.exit(0);
    } else {
      console.log("\n💥 Transaction failed");
      process.exit(1);
    }
  } catch (error) {
    console.error("\n💥 Fatal error:", error);
    process.exit(1);
  }
})();