import { CdpClient } from "@coinbase/cdp-sdk";
import { parseEther, isAddress } from "viem";
import dotenv from "dotenv";
dotenv.config();

// Validate environment variables
if (!process.env.CDP_API_KEY || !process.env.CDP_PRIVATE_KEY) {
  throw new Error("Missing required environment variables: CDP_API_KEY or CDP_PRIVATE_KEY");
}

// Configuration
const CONFIG = {
  NETWORK: "base-mainnet" as const,
  RECIPIENT_ADDRESS: "0x75ba0000000000000000000000000000000000000", // Change this!
  VALUE: parseEther("0"),
  DATA: "0x",
  TIMEOUT_MS: 200000, // 3 minutes
};

// Main execution function
async function executeTransaction() {
  console.log("🚀 Starting transaction...\n");

  try {
    // Initialize CDP client
    const cdp = new CdpClient();
    console.log("✅ CDP client initialized");

    // Create owner account
    console.log("\n📝 Creating owner account...");
    const owner = await cdp.evm.createAccount({});
    
    if (!owner?.address) {
      throw new Error("Failed to create owner account");
    }
    
    console.log("✅ Created owner account:", owner.address);

    // Create smart account
    console.log("\n📝 Creating smart account...");
    const smartAccount = await cdp.evm.createSmartAccount({ owner });
    
    if (!smartAccount?.address) {
      throw new Error("Failed to create smart account");
    }
    
    console.log("✅ Created smart account:", smartAccount.address);

    // Validate recipient address (WARNING: zero address will burn funds!)
    if (!isAddress(CONFIG.RECIPIENT_ADDRESS)) {
      throw new Error(`Invalid recipient address: ${CONFIG.RECIPIENT_ADDRESS}`);
    }
    
    if (CONFIG.RECIPIENT_ADDRESS === "0x0000000000000000000000000000000000000000") {
      console.warn("\n⚠️  WARNING: Sending to zero address (0x0...0) will burn funds!");
      console.warn("⚠️  Please update CONFIG.RECIPIENT_ADDRESS to a valid address on base\n");
    }

    // Send user operation
    console.log("\n📤 Sending user operation...");
    const result = await cdp.evm.sendUserOperation({
      smartAccount,
      network: CONFIG.NETWORK,
      calls: [
        {
          to: CONFIG.RECIPIENT_ADDRESS,
          value: CONFIG.VALUE,
          data: CONFIG.DATA,
        },
      ],
    });

    console.log("✅ User operation sent");
    console.log("   Status:", result.status);
    console.log("   Hash:", result.userOpHash);

    // Wait for confirmation with timeout
    console.log("\n⏳ Waiting for user operation to be confirmed...");
    
    const confirmationPromise = cdp.evm.waitForUserOperation({
      smartAccountAddress: smartAccount.address,
      userOpHash: result.userOpHash,
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Transaction confirmation timeout")), CONFIG.TIMEOUT_MS)
    );

    const userOperation = await Promise.race([confirmationPromise, timeoutPromise]);

    // Check final status
    if (userOperation.status === "complete") {
      const explorerLink = `https://basescan.org/tx/${userOperation.transactionHash}`;
      console.log("\n✅ User operation confirmed successfully on base mainnet!");
      console.log("   Transaction hash:", userOperation.transactionHash);
      console.log("   Block explorer:", explorerLink);
      
      return {
        success: true,
        transactionHash: userOperation.transactionHash,
        explorerLink,
      };
    } else {
      throw new Error(`User operation failed with status: ${userOperation.status}`);
    }

  } catch (error) {
    console.error("\n❌ Transaction failed:");
    
    if (error instanceof Error) {
      console.error("   Error:", error.message);
      
      // Log additional details in development
      if (process.env.NODE_ENV !== "production") {
        console.error("   Stack:", error.stack);
      }
    } else {
      console.error("   Unknown error:", error);
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// Execute with proper error handling
executeTransaction()
  .then((result) => {
    if (result.success) {
      console.log("\n✨ Process completed successfully");
      process.exit(0);
    } else {
      console.log("\n💥 Process failed");
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error("\n💥 Fatal error:", error);
    process.exit(1);
  });