// server.ts
import express, { Request, Response } from "express";
import { CdpClient } from "@coinbase/cdp-sdk";
import { createPublicClient, http, parseUnits, encodeFunctionData, formatUnits, createWalletClient } from "viem";
import { baseSepolia, sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";

dotenv.config();

const app = express();

// IMPORTANT: Middleware must be configured properly
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Configuration
const BRIDGE_ADDRESSES = {
  sepolia: "0xcCDaC15b8E7C4Aa44b12B3acA6D8469B7a9F970a",
  "base-sepolia": "0x41fFA79190fF1B2127FBf31B359B64392a026C58",
};

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

// CDP SDK expects different network names
const CDP_NETWORK_NAMES = {
  "sepolia": "ethereum-sepolia",
  "base-sepolia": "base-sepolia",
} as const;

const FUNDING_WALLET_PRIVATE_KEY = process.env.CUSTOMWALLET 
  ? `0x${process.env.CUSTOMWALLET}` 
  : "";

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
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transfer",
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
] as const;

// In-memory store for active bridge requests
interface BridgeSession {
  id: string;
  sourceChain: NetworkType;
  destinationChain: NetworkType;
  amountUSDT: string;
  destinationWallet: string;
  smartWalletAddress: string;
  depositAddress: string;
  status: "pending_deposit" | "processing" | "completed" | "failed";
  txHash?: string;
  error?: string;
  createdAt: Date;
  walletInfo: any;
}

const activeSessions = new Map<string, BridgeSession>();

// Helper functions
async function createSmartWallet(cdp: CdpClient) {
  const owner = await cdp.evm.createAccount();
  const smartAccount = await cdp.evm.createSmartAccount({ owner });

  return {
    owner,
    smartAccount,
    ownerAddress: owner.address,
    smartWalletAddress: smartAccount.address,
    depositAddress: smartAccount.address,
  };
}

async function checkETHBalance(address: string, chain: NetworkType): Promise<bigint> {
  const publicClient = createPublicClient({
    chain: CHAIN_CONFIG[chain],
    transport: http(),
  });

  return await publicClient.getBalance({
    address: address as `0x${string}`,
  });
}

async function waitForETHBalance(
  address: string,
  chain: NetworkType,
  requiredAmount: bigint,
  maxAttempts: number = 60
): Promise<void> {
  const publicClient = createPublicClient({
    chain: CHAIN_CONFIG[chain],
    transport: http(),
  });

  for (let i = 0; i < maxAttempts; i++) {
    const balance = await publicClient.getBalance({
      address: address as `0x${string}`,
    });

    if (balance >= requiredAmount) {
      console.log(`   ✅ ETH balance confirmed: ${formatUnits(balance, 18)} ETH`);
      return;
    }

    if (i % 6 === 0) {
      console.log(`   ⏳ Waiting for ETH balance: ${formatUnits(balance, 18)} / ${formatUnits(requiredAmount, 18)} ETH...`);
    }

    await new Promise(resolve => setTimeout(resolve, 2000)); // Check every 2 seconds
  }

  throw new Error(`Timeout waiting for ETH balance. Required: ${formatUnits(requiredAmount, 18)} ETH`);
}

async function fundSmartWalletWithETH(
  smartWalletAddress: string,
  chain: NetworkType,
  amount: bigint
): Promise<string> {
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

  const fundingBalance = await publicClient.getBalance({
    address: account.address,
  });

  console.log(`   💰 Funding wallet: ${account.address}`);
  console.log(`   💰 Funding wallet balance: ${formatUnits(fundingBalance, 18)} ETH`);

  if (fundingBalance < amount) {
    throw new Error(
      `Insufficient funds in funding wallet. Need ${formatUnits(amount, 18)} ETH, have ${formatUnits(fundingBalance, 18)} ETH`
    );
  }

  const hash = await walletClient.sendTransaction({
    to: smartWalletAddress as `0x${string}`,
    value: amount,
  });

  console.log(`   📤 Funding tx hash: ${hash}`);
  console.log(`   ⏳ Waiting for confirmation...`);

  await publicClient.waitForTransactionReceipt({ hash });

  console.log(`   ✅ Sent ${formatUnits(amount, 18)} ETH to smart wallet`);
  
  return hash;
}

async function checkUSDTBalance(address: string, chain: NetworkType): Promise<bigint> {
  const publicClient = createPublicClient({
    chain: CHAIN_CONFIG[chain],
    transport: http(),
  });

  const usdtAddress = USDT_ADDRESSES[chain];

  return await publicClient.readContract({
    address: usdtAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address as `0x${string}`],
  }) as bigint;
}

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

async function executeBridge(
  cdp: CdpClient,
  walletInfo: any,
  sourceChain: NetworkType,
  destinationChain: NetworkType,
  destinationWallet: string,
  amount: bigint,
  lzFee: bigint
): Promise<string> {
  const bridgeAddress = BRIDGE_ADDRESSES[sourceChain];
  const usdtAddress = USDT_ADDRESSES[sourceChain];
  const destEid = CHAIN_EIDS[destinationChain];

  // Verify balances one more time before executing
  const publicClient = createPublicClient({
    chain: CHAIN_CONFIG[sourceChain],
    transport: http(),
  });

  const ethBalance = await publicClient.getBalance({
    address: walletInfo.smartAccount.address as `0x${string}`,
  });

  const usdtBalance = await publicClient.readContract({
    address: usdtAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [walletInfo.smartAccount.address as `0x${string}`],
  }) as bigint;

  console.log(`   🔍 Pre-execution verification:`);
  console.log(`   - ETH Balance: ${formatUnits(ethBalance, 18)} ETH`);
  console.log(`   - USDT Balance: ${formatUnits(usdtBalance, 6)} USDT`);
  console.log(`   - Required USDT: ${formatUnits(amount, 6)} USDT`);
  console.log(`   - LZ Fee: ${formatUnits(lzFee, 18)} ETH`);

  if (usdtBalance < amount) {
    throw new Error(`Insufficient USDT: have ${formatUnits(usdtBalance, 6)}, need ${formatUnits(amount, 6)}`);
  }

  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [bridgeAddress as `0x${string}`, amount],
  });

  const bridgeData = encodeFunctionData({
    abi: BRIDGE_ABI,
    functionName: "bridge",
    args: [destEid, destinationWallet as `0x${string}`, amount, "0x" as `0x${string}`],
  });

  console.log(`   🔧 Preparing user operation...`);
  console.log(`   ✅ Approve: ${formatUnits(amount, 6)} USDT`);
  console.log(`   ✅ Bridge with: ${formatUnits(lzFee, 18)} ETH for LayerZero`);
  
  // Validate inputs before submitting
  console.log(`   🔍 Validating transaction parameters...`);
  console.log(`   - Smart Account: ${walletInfo.smartAccount.address}`);
  console.log(`   - USDT Token: ${usdtAddress}`);
  console.log(`   - Bridge Contract: ${bridgeAddress}`);
  console.log(`   - Destination EID: ${destEid}`);
  console.log(`   - Destination Wallet: ${destinationWallet}`);
  console.log(`   - Amount: ${formatUnits(amount, 6)} USDT`);
  console.log(`   - LZ Fee: ${formatUnits(lzFee, 18)} ETH`);

  const result = await cdp.evm.sendUserOperation({
    smartAccount: walletInfo.smartAccount,
    network: CDP_NETWORK_NAMES[sourceChain], // FIX: Use CDP-compatible network name
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

  console.log(`   📝 UserOp Hash: ${result.userOpHash}`);
  console.log(`   ⏳ Waiting for user operation to complete...`);

  const userOperation = await cdp.evm.waitForUserOperation({
    smartAccountAddress: walletInfo.smartAccount.address,
    userOpHash: result.userOpHash,
  });

  console.log(`   📊 UserOp Status: ${userOperation.status}`);
  
  if (userOperation.status !== "complete") {
    // Try to get more details about the failure
    console.error(`   ❌ Transaction failed with status: ${userOperation.status}`);
    console.error(`   📝 Full userOperation object:`, JSON.stringify(userOperation, null, 2));
    
    throw new Error(`Transaction failed: ${userOperation.status}. Check logs for details.`);
  }

  console.log(`   ✅ Transaction successful!`);
  console.log(`   📝 TX Hash: ${userOperation.transactionHash}`);

  return userOperation.transactionHash;
}

// Background worker to monitor deposits and execute bridges
async function processSession(sessionId: string) {
  const session = activeSessions.get(sessionId);
  if (!session) return;

  try {
    const cdp = new CdpClient();
    const amount = parseUnits(session.amountUSDT, 6);

    console.log(`\n${"=".repeat(60)}`);
    console.log(`[${sessionId}] 🔄 Monitoring session...`);
    console.log(`${"=".repeat(60)}`);

    // Wait for USDT deposit
    let attempts = 0;
    const maxAttempts = 240; // 20 minutes

    while (attempts < maxAttempts) {
      const usdtBalance = await checkUSDTBalance(
        session.depositAddress,
        session.sourceChain
      );

      if (usdtBalance >= amount) {
        console.log(`\n[${sessionId}] 💰 USDT received! Processing bridge...`);
        session.status = "processing";
        activeSessions.set(sessionId, session);

        // Get quote
        console.log(`[${sessionId}] 📊 Getting bridge quote...`);
        const quote = await getBridgeQuote(
          session.sourceChain,
          session.destinationChain,
          amount
        );

        console.log(`[${sessionId}] 💵 Quote:`);
        console.log(`   - LayerZero fee: ${formatUnits(quote.lzFee, 18)} ETH`);
        console.log(`   - LP fee: ${formatUnits(quote.lpFee, 6)} USDT`);
        console.log(`   - Protocol fee: ${formatUnits(quote.protocolFee, 6)} USDT`);
        console.log(`   - Recipient receives: ${formatUnits(quote.amountToReceive, 6)} USDT`);

        // Calculate required ETH: LayerZero fee + gas for user operation
        // User operations on ERC-4337 need ETH for bundler gas + the actual call gas
        const publicClient = createPublicClient({
          chain: CHAIN_CONFIG[session.sourceChain],
          transport: http(),
        });
        const gasPrice = await publicClient.getGasPrice();
        
        console.log(`[${sessionId}] ⛽ Current gas price: ${formatUnits(gasPrice, 9)} gwei`);
        
        // ERC-4337 user operations typically need:
        // - verificationGasLimit: ~100k-150k gas
        // - callGasLimit: ~200k-300k gas for approve + bridge
        // - preVerificationGas: ~21k gas
        // Total: ~400k gas conservatively
        const estimatedGas = 500000n; // Very conservative estimate
        const estimatedGasCost = estimatedGas * gasPrice;
        
        console.log(`[${sessionId}] 📊 Gas estimation:`);
        console.log(`   - Estimated gas: ${estimatedGas.toString()} units`);
        console.log(`   - Estimated cost: ${formatUnits(estimatedGasCost, 18)} ETH`);
        console.log(`   - LayerZero fee: ${formatUnits(quote.lzFee, 18)} ETH`);
        
        // Total = LayerZero fee + gas costs + 100% safety margin
        const requiredETH = (quote.lzFee + estimatedGasCost) * 2n;

        // Check current ETH balance
        const currentETH = await checkETHBalance(
          session.depositAddress,
          session.sourceChain
        );

        console.log(`\n[${sessionId}] 💸 ETH Balance Check:`);
        console.log(`   - Current: ${formatUnits(currentETH, 18)} ETH`);
        console.log(`   - Required: ${formatUnits(requiredETH, 18)} ETH`);

        if (currentETH < requiredETH) {
          const amountToFund = requiredETH - currentETH;
          // Auto-fund with ETH
          console.log(`\n[${sessionId}] 🔄 Funding smart wallet...`);
          console.log(`   - Current balance: ${formatUnits(currentETH, 18)} ETH`);
          console.log(`   - Required balance: ${formatUnits(requiredETH, 18)} ETH`);
          console.log(`   - Sending: ${formatUnits(amountToFund, 18)} ETH`);
          
          const fundingTxHash = await fundSmartWalletWithETH(
            session.depositAddress,
            session.sourceChain,
            amountToFund
          );
          
          console.log(`\n[${sessionId}] ⏳ Waiting for ETH balance to update...`);

          // Wait for ETH balance to update with longer timeout
          await waitForETHBalance(
            session.depositAddress,
            session.sourceChain,
            requiredETH,
            90 // 3 minutes max
          );

          console.log(`[${sessionId}] ✅ ETH funding confirmed!`);
        } else {
          console.log(`[${sessionId}] ✅ Sufficient ETH already available`);
        }

        // Double-check balances before executing
        const finalETH = await checkETHBalance(
          session.depositAddress,
          session.sourceChain
        );
        const finalUSDT = await checkUSDTBalance(
          session.depositAddress,
          session.sourceChain
        );

        console.log(`\n[${sessionId}] 📊 Final balances:`);
        console.log(`   - ETH: ${formatUnits(finalETH, 18)} ETH`);
        console.log(`   - USDT: ${formatUnits(finalUSDT, 6)} USDT`);
        console.log(`   - Required ETH: ${formatUnits(requiredETH, 18)} ETH`);

        if (finalETH < requiredETH) {
          throw new Error(
            `Insufficient ETH after funding. Have ${formatUnits(finalETH, 18)} ETH, need ${formatUnits(requiredETH, 18)} ETH`
          );
        }

        // Add a small delay to ensure everything is settled
        console.log(`[${sessionId}] ⏳ Waiting 10 seconds for blockchain state to settle...`);
        await new Promise(resolve => setTimeout(resolve, 10000));

        // Execute bridge
        console.log(`\n[${sessionId}] 🌉 Executing bridge...`);
        const txHash = await executeBridge(
          cdp,
          session.walletInfo,
          session.sourceChain,
          session.destinationChain,
          session.destinationWallet,
          amount,
          quote.lzFee
        );

        session.status = "completed";
        session.txHash = txHash;
        activeSessions.set(sessionId, session);

        console.log(`\n${"=".repeat(60)}`);
        console.log(`[${sessionId}] 🎉 BRIDGE COMPLETED!`);
        console.log(`${"=".repeat(60)}`);
        console.log(`   TX Hash: ${txHash}`);
        console.log(`   Explorer: https://${session.sourceChain === "base-sepolia" ? "sepolia.basescan.org" : "sepolia.etherscan.io"}/tx/${txHash}`);
        console.log(`   LayerZero: https://testnet.layerzeroscan.com/tx/${txHash}`);
        console.log(`${"=".repeat(60)}\n`);
        return;
      }

      if (attempts % 6 === 0) {
        console.log(`[${sessionId}] ⏳ Waiting for USDT deposit... (${formatUnits(usdtBalance, 6)} / ${formatUnits(amount, 6)} USDT)`);
      }

      await new Promise(resolve => setTimeout(resolve, 5000));
      attempts++;
    }

    // Timeout
    session.status = "failed";
    session.error = "Timeout waiting for USDT deposit";
    activeSessions.set(sessionId, session);
    console.log(`\n[${sessionId}] ❌ Timeout - no USDT received after 20 minutes\n`);

  } catch (error: any) {
    console.error(`\n[${sessionId}] ❌ Error:`, error.message);
    console.error(error);
    session.status = "failed";
    session.error = error.message;
    activeSessions.set(sessionId, session);
  }
}

// API Routes

/**
 * GET /
 * Root endpoint with API info
 */
app.get("/", (req: Request, res: Response) => {
  res.json({
    name: "Smart Wallet Bridge API",
    version: "1.0.0",
    description: "Cross-chain USDT bridge using smart wallets and LayerZero",
    endpoints: {
      "POST /bridge/create": "Create a new bridge request",
      "GET /bridge/status/:sessionId": "Get status of a bridge request",
      "GET /bridge/sessions": "List all active sessions",
      "POST /faucet/usdt": "Request testnet USDT from faucet",
      "GET /health": "Health check"
    },
    supportedChains: ["sepolia", "base-sepolia"],
    usdtAddresses: USDT_ADDRESSES,
    examples: {
      createBridge: {
        method: "POST",
        url: "/bridge/create",
        body: {
          sourceChain: "base-sepolia",
          destinationChain: "sepolia",
          amountUSDT: "10",
          destinationWallet: "0x..."
        }
      },
      faucet: {
        method: "POST",
        url: "/faucet/usdt",
        body: {
          address: "0x...",
          chain: "base-sepolia",
          amount: "10"
        }
      }
    }
  });
});

/**
 * POST /bridge/create
 * Create a new bridge request
 */
app.post("/bridge/create", async (req: Request, res: Response) => {
  try {
    console.log("\n📝 Received bridge request:", req.body);
    
    const { sourceChain, destinationChain, amountUSDT, destinationWallet } = req.body;

    // Validation
    if (!sourceChain || !destinationChain || !amountUSDT || !destinationWallet) {
      return res.status(400).json({
        error: "Missing required fields",
        required: ["sourceChain", "destinationChain", "amountUSDT", "destinationWallet"],
        received: req.body
      });
    }

    if (!["sepolia", "base-sepolia"].includes(sourceChain) || 
        !["sepolia", "base-sepolia"].includes(destinationChain)) {
      return res.status(400).json({
        error: "Invalid chain. Use 'sepolia' or 'base-sepolia'"
      });
    }

    if (sourceChain === destinationChain) {
      return res.status(400).json({
        error: "Source and destination chains must be different"
      });
    }

    // Create smart wallet
    console.log("🔧 Creating smart wallet...");
    const cdp = new CdpClient();
    const walletInfo = await createSmartWallet(cdp);

    // Create session
    const sessionId = `bridge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const session: BridgeSession = {
      id: sessionId,
      sourceChain,
      destinationChain,
      amountUSDT,
      destinationWallet,
      smartWalletAddress: walletInfo.smartWalletAddress,
      depositAddress: walletInfo.depositAddress,
      status: "pending_deposit",
      createdAt: new Date(),
      walletInfo,
    };

    activeSessions.set(sessionId, session);

    // Start background processing
    processSession(sessionId);

    console.log(`✅ Bridge session created: ${sessionId}\n`);

    res.json({
      success: true,
      sessionId,
      depositAddress: walletInfo.depositAddress,
      smartWalletAddress: walletInfo.smartWalletAddress,
      sourceChain,
      destinationChain,
      amountUSDT,
      destinationWallet,
      message: `Send ${amountUSDT} USDT to ${walletInfo.depositAddress} on ${sourceChain}`,
      instructions: {
        step1: `Send ${amountUSDT} USDT to the deposit address`,
        step2: "Bridge will execute automatically after deposit is detected",
        step3: `Funds will arrive at ${destinationWallet} on ${destinationChain}`,
      }
    });

  } catch (error: any) {
    console.error("❌ Error creating bridge:", error);
    res.status(500).json({
      error: "Failed to create bridge",
      message: error.message
    });
  }
});

/**
 * GET /bridge/status/:sessionId
 * Get status of a bridge request
 */
app.get("/bridge/status/:sessionId", async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const session = activeSessions.get(sessionId);

    if (!session) {
      return res.status(404).json({
        error: "Session not found"
      });
    }

    const response: any = {
      sessionId: session.id,
      status: session.status,
      sourceChain: session.sourceChain,
      destinationChain: session.destinationChain,
      amountUSDT: session.amountUSDT,
      destinationWallet: session.destinationWallet,
      depositAddress: session.depositAddress,
      createdAt: session.createdAt,
    };

    if (session.status === "completed" && session.txHash) {
      response.txHash = session.txHash;
      response.explorerUrl = session.sourceChain === "base-sepolia"
        ? `https://sepolia.basescan.org/tx/${session.txHash}`
        : `https://sepolia.etherscan.io/tx/${session.txHash}`;
      response.layerZeroUrl = `https://testnet.layerzeroscan.com/tx/${session.txHash}`;
    }

    if (session.status === "failed" && session.error) {
      response.error = session.error;
    }

    res.json(response);

  } catch (error: any) {
    console.error("Error getting status:", error);
    res.status(500).json({
      error: "Failed to get status",
      message: error.message
    });
  }
});

/**
 * GET /bridge/sessions
 * List all active sessions
 */
app.get("/bridge/sessions", (req: Request, res: Response) => {
  const sessions = Array.from(activeSessions.values()).map(session => ({
    sessionId: session.id,
    status: session.status,
    sourceChain: session.sourceChain,
    destinationChain: session.destinationChain,
    amountUSDT: session.amountUSDT,
    destinationWallet: session.destinationWallet,
    depositAddress: session.depositAddress,
    createdAt: session.createdAt,
    txHash: session.txHash,
  }));

  res.json({
    totalSessions: sessions.length,
    sessions
  });
});

/**
 * POST /faucet/usdt
 * Request testnet USDT from the faucet
 */
app.post("/faucet/usdt", async (req: Request, res: Response) => {
  try {
    const { address, chain, amount } = req.body;

    // Validation
    if (!address || !chain) {
      return res.status(400).json({
        error: "Missing required fields",
        required: ["address", "chain"],
        optional: ["amount (default: 10)"],
        received: req.body
      });
    }

    if (!["sepolia", "base-sepolia"].includes(chain)) {
      return res.status(400).json({
        error: "Invalid chain. Use 'sepolia' or 'base-sepolia'"
      });
    }

    // Default amount is 10 USDT if not specified
    const usdtAmount = amount || "10";
    const amountInWei = parseUnits(usdtAmount, 6);

    if (!FUNDING_WALLET_PRIVATE_KEY) {
      return res.status(500).json({
        error: "Faucet not configured",
        message: "CUSTOMWALLET environment variable not set"
      });
    }

    console.log(`\n💧 USDT Faucet Request:`);
    console.log(`   - Recipient: ${address}`);
    console.log(`   - Chain: ${chain}`);
    console.log(`   - Amount: ${usdtAmount} USDT`);

    const account = privateKeyToAccount(FUNDING_WALLET_PRIVATE_KEY as `0x${string}`);
    
    const walletClient = createWalletClient({
      account,
      chain: CHAIN_CONFIG[chain as NetworkType],
      transport: http(),
    });

    const publicClient = createPublicClient({
      chain: CHAIN_CONFIG[chain as NetworkType],
      transport: http(),
    });

    const usdtAddress = USDT_ADDRESSES[chain as NetworkType];

    // Check faucet USDT balance
    const faucetBalance = await publicClient.readContract({
      address: usdtAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    }) as bigint;

    console.log(`   💰 Faucet balance: ${formatUnits(faucetBalance, 6)} USDT`);

    if (faucetBalance < amountInWei) {
      return res.status(400).json({
        error: "Insufficient faucet balance",
        message: `Faucet has ${formatUnits(faucetBalance, 6)} USDT, but ${usdtAmount} USDT was requested`,
        faucetBalance: formatUnits(faucetBalance, 6)
      });
    }

    // Encode the transfer function call
    const transferData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [address as `0x${string}`, amountInWei],
    });

    // Send the USDT transfer transaction
    console.log(`   📤 Sending ${usdtAmount} USDT...`);
    
    const hash = await walletClient.sendTransaction({
      to: usdtAddress as `0x${string}`,
      data: transferData,
    });

    console.log(`   📝 TX Hash: ${hash}`);
    console.log(`   ⏳ Waiting for confirmation...`);

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    console.log(`   ✅ USDT sent successfully!`);

    const explorerUrl = chain === "base-sepolia"
      ? `https://sepolia.basescan.org/tx/${hash}`
      : `https://sepolia.etherscan.io/tx/${hash}`;

    res.json({
      success: true,
      txHash: hash,
      recipient: address,
      chain,
      amount: usdtAmount,
      usdtToken: usdtAddress,
      explorerUrl,
      message: `Successfully sent ${usdtAmount} USDT to ${address} on ${chain}`,
      blockNumber: receipt.blockNumber.toString()
    });


  } catch (error: any) {
    console.error("❌ Faucet error:", error);
    res.status(500).json({
      error: "Faucet request failed",
      message: error.message
    });
  }
});

/**
 * GET /health
 * Health check endpoint
 */
app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    activeSessions: activeSessions.size,
    fundingWalletConfigured: !!FUNDING_WALLET_PRIVATE_KEY
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 Bridge API Server");
  console.log("=".repeat(60));
  console.log(`📡 Server running on: http://localhost:${PORT}`);
  console.log(`💰 Funding wallet configured: ${!!FUNDING_WALLET_PRIVATE_KEY ? "✅ Yes" : "❌ No"}`);
  console.log("\n📋 Available Endpoints:");
  console.log(`   GET    http://localhost:${PORT}/`);
  console.log(`   POST   http://localhost:${PORT}/bridge/create`);
  console.log(`   GET    http://localhost:${PORT}/bridge/status/:sessionId`);
  console.log(`   GET    http://localhost:${PORT}/bridge/sessions`);
  console.log(`   POST   http://localhost:${PORT}/faucet/usdt`);
  console.log(`   GET    http://localhost:${PORT}/health`);
  console.log("\n💡 Quick Test - Get USDT from Faucet:");
  console.log(`   curl -X POST http://localhost:${PORT}/faucet/usdt \\`);
  console.log(`     -H "Content-Type: application/json" \\`);
  console.log(`     -d '{"address":"0xYourAddress","chain":"base-sepolia","amount":"10"}'`);
  console.log("\n💡 Quick Test - Bridge USDT:");
  console.log(`   curl -X POST http://localhost:${PORT}/bridge/create \\`);
  console.log(`     -H "Content-Type: application/json" \\`);
  console.log(`     -d '{"sourceChain":"base-sepolia","destinationChain":"sepolia","amountUSDT":"10","destinationWallet":"0x22890dfAeD0667723fcD66e34FfB853b4F81f6bd"}'`);
  console.log("=".repeat(60) + "\n");
});