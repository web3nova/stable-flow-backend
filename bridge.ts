import { CdpClient } from "@coinbase/cdp-sdk";
import { createPublicClient, http, parseUnits, encodeFunctionData, formatUnits, parseEther, createWalletClient } from "viem";
import { baseSepolia, sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";

dotenv.config();

// Configuration
//const BRIDGE_ADDRESSES = {
//  sepolia: "0xcCDaC15b8E7C4Aa44b12B3acA6D8469B7a9F970a",
//  "base-sepolia": "0x41fFA79190fF1B2127FBf31B359B64392a026C58",
//};

const USDT_ADDRESSES = {
  sepolia: "0x21dE5De8A2b4A7c0f8198ac240403Af7d093179e",
  "base-sepolia": "0xFB8C2026977FB4f580D0021D76843325e724Fa04",
};

const CHAIN_EIDS = {
  sepolia: 40161,
  "base-sepolia": 40245,
};

const CHAIN_CONFIG = {
  "base-sepolia": baseSepolia,
  sepolia: sepolia,
};

// Funding wallet configuration (from .env)
const FUNDING_WALLET_PRIVATE_KEY = process.env.CUSTOMWALLET 
  ? `0x${process.env.CUSTOMWALLET}` 
  : "";

// Configurable destination wallet (from .env)
const DEFAULT_DESTINATION_WALLET = process.env.DESTINATION_WALLET || "0x22890dfAeD0667723fcD66e34FfB853b4F81f6bd";

// Configurable bridge parameters (from .env)
const SOURCE_CHAIN = (process.env.SOURCE_CHAIN || "base-sepolia") as NetworkType;
const DESTINATION_CHAIN = (process.env.DESTINATION_CHAIN || "sepolia") as NetworkType;
const BRIDGE_AMOUNT = process.env.BRIDGE_AMOUNT || "10";

// Type for supported networks
type NetworkType = "sepolia" | "base-sepolia";

// ABIs
const BRIDGE_ABI = [
  {
    inputs: [
      { name: "_dstEid", type: "uint32" },
      { name: "_recipient", type: "address" },
      { name: "_amount", type: "uint256" },
      { name: "_extraOptions", type: "bytes" },
    ],
    name: "bridge",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { name: "_dstEid", type: "uint32" },
      { name: "_amount", type: "uint256" },
      { name: "_extraOptions", type: "bytes" },
    ],
    name: "getCompleteQuote",
    outputs: [
      { name: "lzFee", type: "uint256" },
      { name: "lpFee", type: "uint256" },
      { name: "protocolFee", type: "uint256" },
      { name: "totalBridgeFee", type: "uint256" },
      { name: "amountToReceive", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const ERC20_ABI = [
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

interface BridgeRequest {
  sourceChain: NetworkType;
  destinationChain: NetworkType;
  amountUSDT: string;
  destinationWallet: string;
}

interface SmartWalletInfo {
  owner: any;
  smartAccount: any;
  ownerAddress: string;
  smartWalletAddress: string;
  depositAddress: string;
}

/**
 * Main function: Creates smart wallet and bridges USDT to destination
 * Automatically funds the smart wallet with ETH from a pre-funded owner wallet
 */
async function createSmartWalletAndBridge(request: BridgeRequest): Promise<void> {
  const cdp = new CdpClient();

  console.log("🚀 Starting Bridge Request (Auto-Funded)");
  console.log("=".repeat(60));
  console.log(`Source Chain: ${request.sourceChain}`);
  console.log(`Destination Chain: ${request.destinationChain}`);
  console.log(`Amount: ${request.amountUSDT} USDT`);
  console.log(`Final Recipient: ${request.destinationWallet}`);
  console.log("=".repeat(60));
  console.log();

  // STEP 1: Create Smart Wallet
  console.log("📝 STEP 1: Creating Smart Wallet...");
  const walletInfo = await createSmartWallet(cdp);
  console.log(`   ✅ Owner Account: ${walletInfo.ownerAddress}`);
  console.log(`   ✅ Smart Wallet: ${walletInfo.smartWalletAddress}`);
  console.log(`   💰 Deposit Address: ${walletInfo.depositAddress}`);
  console.log();

  // STEP 2: Get quote first to know how much ETH is needed
  console.log("💰 STEP 2: Calculating fees...");
  const amount = parseUnits(request.amountUSDT, 6);
  const quote = await getBridgeQuote(
    request.sourceChain,
    request.destinationChain,
    amount
  );
  console.log(`   LayerZero fee: ${formatUnits(quote.lzFee, 18)} ETH`);
  console.log(`   LP fee: ${formatUnits(quote.lpFee, 6)} USDT`);
  console.log(`   Protocol fee: ${formatUnits(quote.protocolFee, 6)} USDT`);
  console.log(`   Recipient receives: ${formatUnits(quote.amountToReceive, 6)} USDT`);
  console.log();

  // STEP 3: Auto-fund smart wallet with ETH immediately
  console.log("💸 STEP 3: Auto-funding smart wallet with ETH...");
  const requiredETH = (quote.lzFee * 120n) / 100n; // 20% buffer
  
  console.log(`   Required ETH: ${formatUnits(requiredETH, 18)} ETH`);
  console.log(`   🔄 Funding from custom wallet...`);
  
  await fundSmartWalletWithETH(
    walletInfo.depositAddress,
    request.sourceChain,
    requiredETH
  );
  
  console.log(`   ✅ Smart wallet funded with ETH`);
  console.log();

  // STEP 4: Wait for USDT deposit
  console.log("⏳ STEP 4: Waiting for USDT deposit...");
  console.log(`   Send ${request.amountUSDT} USDT to: ${walletInfo.depositAddress}`);
  console.log(`   on ${request.sourceChain}`);
  console.log();
  console.log("   ⛽ Transaction gas will be sponsored by Coinbase Paymaster!");
  console.log();
  console.log("   💡 FOR TESTING:");
  console.log(`   SMART_WALLET=${walletInfo.depositAddress} npx hardhat run scripts/send-usdt-to-smart-wallet.js --network ${request.sourceChain}`);
  console.log();

  // Wait for USDT
  await waitForUSDTDeposit(
    walletInfo.depositAddress,
    request.sourceChain,
    amount
  );
  console.log(`   ✅ Received ${request.amountUSDT} USDT`);
  console.log();

  // STEP 5: Execute bridge transaction with paymaster
  console.log("🌉 STEP 5: Executing bridge transaction...");
  console.log("   ⛽ Using Coinbase Paymaster for transaction gas");
  const txHash = await executeBridgeWithPaymaster(
    cdp,
    walletInfo,
    request,
    amount,
    quote.lzFee
  );
  console.log(`   ✅ Transaction Hash: ${txHash}`);
  console.log();

  // STEP 6: Track cross-chain delivery
  console.log("🎉 BRIDGE REQUEST COMPLETED!");
  console.log("=".repeat(60));
  console.log(`Smart Wallet: ${walletInfo.smartWalletAddress}`);
  console.log(`Transaction: https://${request.sourceChain === "base-sepolia" ? "sepolia.basescan.org" : "sepolia.etherscan.io"}/tx/${txHash}`);
  console.log(`LayerZero Tracker: https://testnet.layerzeroscan.com/tx/${txHash}`);
  console.log();
  console.log(`💰 ${formatUnits(quote.amountToReceive, 6)} USDT will arrive at:`);
  console.log(`   ${request.destinationWallet}`);
  console.log(`   on ${request.destinationChain}`);
  console.log();
  console.log("⏰ Cross-chain delivery: 1-3 minutes");
  console.log("=".repeat(60));
}

/**
 * Creates a smart wallet (owner + smart account)
 */
async function createSmartWallet(cdp: CdpClient): Promise<SmartWalletInfo> {
  const owner = await cdp.evm.createAccount();
  const smartAccount = await cdp.evm.createSmartAccount({
    owner,
  });

  return {
    owner,
    smartAccount,
    ownerAddress: owner.address,
    smartWalletAddress: smartAccount.address,
    depositAddress: smartAccount.address,
  };
}

/**
 * Check ETH balance of an address
 */
async function checkETHBalance(
  address: string,
  chain: NetworkType
): Promise<bigint> {
  const publicClient = createPublicClient({
    chain: CHAIN_CONFIG[chain],
    transport: http(),
  });

  return await publicClient.getBalance({
    address: address as `0x${string}`,
  });
}

/**
 * Fund smart wallet with ETH from the funding wallet
 */
async function fundSmartWalletWithETH(
  smartWalletAddress: string,
  chain: NetworkType,
  amount: bigint
): Promise<void> {
  if (!FUNDING_WALLET_PRIVATE_KEY) {
    throw new Error("CUSTOMWALLET not set in .env");
  }

  const account = privateKeyToAccount(FUNDING_WALLET_PRIVATE_KEY as `0x${string}`);
  
  const walletClient = createWalletClient({
    account,
    chain: CHAIN_CONFIG[chain],
    transport: http(),
  });

  const publicClient = createPublicClient({
    chain: CHAIN_CONFIG[chain],
    transport: http(),
  });

  // Check funding wallet balance
  const fundingBalance = await publicClient.getBalance({
    address: account.address,
  });

  console.log(`   Funding wallet: ${account.address}`);
  console.log(`   Funding wallet balance: ${formatUnits(fundingBalance, 18)} ETH`);

  if (fundingBalance < amount) {
    throw new Error(
      `Insufficient funds in funding wallet. Need ${formatUnits(amount, 18)} ETH, have ${formatUnits(fundingBalance, 18)} ETH`
    );
  }

  // Send ETH to smart wallet
  const hash = await walletClient.sendTransaction({
    to: smartWalletAddress as `0x${string}`,
    value: amount,
  });

  console.log(`   Funding tx hash: ${hash}`);
  console.log(`   Waiting for confirmation...`);

  // Wait for transaction
  await publicClient.waitForTransactionReceipt({ hash });

  console.log(`   ✅ Sent ${formatUnits(amount, 18)} ETH to smart wallet`);
}

/**
 * Waits for USDT to be deposited to the smart wallet
 */
async function waitForUSDTDeposit(
  walletAddress: string,
  chain: NetworkType,
  expectedAmount: bigint
): Promise<void> {
  const publicClient = createPublicClient({
    chain: CHAIN_CONFIG[chain],
    transport: http(),
  });

  const usdtAddress = USDT_ADDRESSES[chain];
  let attempts = 0;
  const maxAttempts = 120; // 10 minutes

  while (attempts < maxAttempts) {
    try {
      const balance = await publicClient.readContract({
        address: usdtAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [walletAddress as `0x${string}`],
      }) as bigint;

      if (balance >= expectedAmount) {
        return;
      }

      if (attempts % 6 === 0) {
        console.log(`   Current USDT: ${formatUnits(balance, 6)} / ${formatUnits(expectedAmount, 6)} USDT (waiting...)`);
      }
    } catch (error) {
      console.error("   Error checking USDT balance:", error);
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
    attempts++;
  }

  throw new Error("Timeout waiting for USDT deposit");
}

/**
 * Gets bridge fee quote
 */
async function getBridgeQuote(
  sourceChain: NetworkType,
  destChain: NetworkType,
  amount: bigint
) {
  const publicClient = createPublicClient({
    chain: CHAIN_CONFIG[sourceChain],
    transport: http(),
  });

  const bridgeAddress = BRIDGE_ADDRESSES[sourceChain];
  const destEid = CHAIN_EIDS[destChain];

  const quote = await publicClient.readContract({
    address: bridgeAddress as `0x${string}`,
    abi: BRIDGE_ABI,
    functionName: "getCompleteQuote",
    args: [destEid, amount, "0x" as `0x${string}`],
  }) as [bigint, bigint, bigint, bigint, bigint];

  const [lzFee, lpFee, protocolFee, totalBridgeFee, amountToReceive] = quote;

  return {
    lzFee,
    lpFee,
    protocolFee,
    totalBridgeFee,
    amountToReceive,
  };
}

/**
 * Executes the bridge transaction WITH PAYMASTER for gas sponsorship
 */
async function executeBridgeWithPaymaster(
  cdp: CdpClient,
  walletInfo: SmartWalletInfo,
  request: BridgeRequest,
  amount: bigint,
  lzFee: bigint
): Promise<string> {
  const bridgeAddress = BRIDGE_ADDRESSES[request.sourceChain];
  const usdtAddress = USDT_ADDRESSES[request.sourceChain];
  const destEid = CHAIN_EIDS[request.destinationChain];

  // Encode approve transaction
  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [bridgeAddress as `0x${string}`, amount],
  });

  // Encode bridge transaction
  const bridgeData = encodeFunctionData({
    abi: BRIDGE_ABI,
    functionName: "bridge",
    args: [destEid, request.destinationWallet as `0x${string}`, amount, "0x" as `0x${string}`],
  });

  console.log("   Preparing user operation with paymaster...");
  console.log(`   Approve: ${formatUnits(amount, 6)} USDT`);
  console.log(`   Bridge with: ${formatUnits(lzFee, 18)} ETH for LayerZero`);
  console.log(`   Gas fees: Sponsored by Coinbase Paymaster ✨`);
  
  // Execute batch transaction
  const result = await cdp.evm.sendUserOperation({
    smartAccount: walletInfo.smartAccount,
    network: request.sourceChain as any,
    calls: [
      {
        to: usdtAddress as `0x${string}`,
        value: 0n,
        data: approveData,
      },
      {
        to: bridgeAddress as `0x${string}`,
        value: lzFee,
        data: bridgeData,
      },
    ],
  });

  console.log(`   UserOp Hash: ${result.userOpHash}`);

  // Wait for confirmation
  console.log("   Waiting for confirmation...");
  const userOperation = await cdp.evm.waitForUserOperation({
    smartAccountAddress: walletInfo.smartAccount.address,
    userOpHash: result.userOpHash,
  });

  if (userOperation.status !== "complete") {
    throw new Error(`Transaction failed: ${userOperation.status}`);
  }

  return userOperation.transactionHash;
}

// ============================================================================
// MAIN EXECUTION - Uses environment variables
// ============================================================================

const bridgeRequest: BridgeRequest = {
  sourceChain: SOURCE_CHAIN,
  destinationChain: DESTINATION_CHAIN,
  amountUSDT: BRIDGE_AMOUNT,
  destinationWallet: DEFAULT_DESTINATION_WALLET,
};

console.log("\n📋 Configuration loaded from .env:");
console.log(`   Source Chain: ${SOURCE_CHAIN}`);
console.log(`   Destination Chain: ${DESTINATION_CHAIN}`);
console.log(`   Amount: ${BRIDGE_AMOUNT} USDT`);
console.log(`   Destination Wallet: ${DEFAULT_DESTINATION_WALLET}`);
console.log();

createSmartWalletAndBridge(bridgeRequest)
  .then(() => {
    console.log("\n✅ Process completed successfully!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Error:", error);
    process.exit(1);
  });
