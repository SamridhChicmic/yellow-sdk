import {
  NitroliteClient,
  WalletStateSigner,
  createGetConfigMessage,
  createECDSAMessageSigner,
  createEIP712AuthMessageSigner,
  createAuthVerifyMessageFromChallenge,
  createCreateChannelMessage,
  createResizeChannelMessage,
  createGetLedgerBalancesMessage,
  createAuthRequestMessage,
  createCloseChannelMessage,
} from "@erc7824/nitrolite";
import type { RPCAsset, RPCNetworkInfo } from "@erc7824/nitrolite";
import { createPublicClient, createWalletClient, http, custom } from "viem";
import { sepolia, baseSepolia } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import "./App.css";
import { useState, useEffect, useRef } from "react";

interface Config {
  assets?: RPCAsset[];
  networks?: RPCNetworkInfo[];
  [key: string]: any;
}

const SUPPORTED_CHAINS = [
  {
    id: sepolia.id,
    name: "Ethereum Sepolia",
    chain: sepolia,
    defaultRpc: "https://1rpc.io/sepolia",
  },
  {
    id: baseSepolia.id,
    name: "Base Sepolia",
    chain: baseSepolia,
    defaultRpc: "https://sepolia.base.org",
  },
];

export default function App() {
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [walletClientState, setWalletClientState] = useState<any>(null);
  const [selectedChainId, setSelectedChainId] = useState<number>(sepolia.id);
  const [logs, setLogs] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("Idle");
  const logsEndRef = useRef<HTMLDivElement>(null);

  const [activeChannelInfo, setActiveChannelInfo] = useState<{
    id: string;
    token: string;
    client: NitroliteClient;
    publicClient: any;
  } | null>(null);
  const [isDepositing, setIsDepositing] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isDepositDone, setIsDepositDone] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const heartbeatIntervalRef = useRef<any>(null);

  const sessionKeyRef = useRef<{
    privateKey: `0x${string}`;
    address: `0x${string}`;
  } | null>(null);

  const addLog = (message: string) => {
    setLogs((prev) => [
      ...prev,
      `[${new Date().toLocaleTimeString()}] ${message}`,
    ]);
  };

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    return () => {
      stopHeartbeat();
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  const startHeartbeat = () => {
    stopHeartbeat();
    heartbeatIntervalRef.current = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({ method: "ping", params: [], id: Date.now() }),
        );
      }
    }, 20000);
  };

  const stopHeartbeat = () => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
    }
  };

  const connectWallet = async () => {
    if (!(window as any).ethereum) {
      alert("MetaMask not found! Please install MetaMask.");
      return;
    }

    try {
      const chainInfo = SUPPORTED_CHAINS.find((c) => c.id === selectedChainId)!;

      const tempClient = createWalletClient({
        chain: chainInfo.chain,
        transport: custom((window as any).ethereum),
      });
      const [address] = await tempClient.requestAddresses();

      if (!address) {
        alert("No wallet address found. Please ensure MetaMask is unlocked.");
        return;
      }

      const walletClient = createWalletClient({
        account: address,
        chain: chainInfo.chain,
        transport: custom((window as any).ethereum),
      });

      setWalletClientState(walletClient);
      setAccount(address);
      addLog(`✓ Wallet Connected: ${address}`);
    } catch (error) {
      console.error("Wallet connection failed:", error);
      alert("Failed to connect wallet. Please try again.");
    }
  };

  async function fetchConfig(pk: `0x${string}`): Promise<Config> {
    addLog("Fetching configuration...");
    const signer = createECDSAMessageSigner(pk);
    const message = await createGetConfigMessage(signer);

    const ws = new WebSocket("wss://clearnet-sandbox.yellow.com/ws");

    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        ws.send(message);
      };

      ws.onmessage = (event) => {
        try {
          const response = JSON.parse(event.data.toString());
          if (response.res && response.res[2]) {
            resolve(response.res[2] as Config);
            ws.close();
          } else if (response.error) {
            reject(new Error(response.error.message || "Unknown RPC error"));
            ws.close();
          }
        } catch (err) {
          reject(err);
          ws.close();
        }
      };

      ws.onerror = (error) => {
        reject(error);
        ws.close();
      };
    });
  }

  const handleDeposit = async () => {
    if (!activeChannelInfo || !account) return;
    const { token, client, publicClient } = activeChannelInfo;

    setIsDepositing(true);
    addLog("Manual Deposit Initiated...");

    try {
      const depositAmount = 20n;
      addLog(`Depositing ${depositAmount} units to Custody...`);
      const depositTx = await client.deposit(
        token as `0x${string}`,
        depositAmount,
      );
      addLog(`✓ Deposit transaction sent: ${depositTx}`);
      addLog("Waiting for deposit confirmation...");
      await publicClient.waitForTransactionReceipt({ hash: depositTx });
      addLog("✓ Deposit confirmed on-chain. You can now Resize.");
      setIsDepositDone(true);
    } catch (error: any) {
      addLog(`Error during deposit: ${error.message || error}`);
    } finally {
      setIsDepositing(false);
    }
  };

  const handleResize = async () => {
    if (!activeChannelInfo || !account || !wsRef.current) return;
    const { id } = activeChannelInfo;

    setIsResizing(true);
    addLog("Manual Resize Initiated...");

    try {
      const resizeAmount = 20n;
      addLog(`Requesting resize for ${resizeAmount} units...`);

      if (!sessionKeyRef.current) throw new Error("Session key missing");
      const sessionSigner = createECDSAMessageSigner(
        sessionKeyRef.current.privateKey,
      );

      const resizeMsg = await createResizeChannelMessage(sessionSigner, {
        channel_id: id as `0x${string}`,
        allocate_amount: resizeAmount,
        funds_destination: account,
      });

      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(resizeMsg);
        addLog("Sent resize_channel message.");
        setActiveChannelInfo(null);
        setIsDepositDone(false); // Reset for potential future channels
      } else {
        addLog("Error: WebSocket connection lost. Please restart the flow.");
      }
    } catch (error: any) {
      addLog(`Error during resize: ${error.message || error}`);
    } finally {
      setIsResizing(false);
    }
  };

  const runFlow = async () => {
    if (!account || !walletClientState) {
      addLog("Error: Wallet not connected");
      return;
    }

    setIsRunning(true);
    setStatus("Running");
    setLogs([]);
    addLog("Starting flow...");
    setActiveChannelInfo(null);
    setIsDepositDone(false);

    try {
      const chainInfo = SUPPORTED_CHAINS.find((c) => c.id === selectedChainId)!;
      addLog(`Selected Chain: ${chainInfo.name}`);

      const currentChainId = await walletClientState.getChainId();
      if (currentChainId !== selectedChainId) {
        addLog(`Switching network to ${chainInfo.name}...`);
        try {
          await walletClientState.switchChain({ id: selectedChainId });
        } catch (e: any) {
          if (e.code === 4902) {
            addLog(
              `Network ${chainInfo.name} not found in wallet. Please add it.`,
            );
          }
          throw e;
        }
      }

      const ALCHEMY_RPC_URL =
        selectedChainId === sepolia.id
          ? import.meta.env.VITE_ALCHEMY_RPC_URL
          : import.meta.env.VITE_BASE_ALCHEMY_RPC_URL;

      const rpcUrl = ALCHEMY_RPC_URL || chainInfo.defaultRpc;

      const publicClient = createPublicClient({
        chain: chainInfo.chain,
        transport: http(rpcUrl),
      });

      if (!sessionKeyRef.current) {
        const sessionPrivateKey = generatePrivateKey();
        const sessionAccount = privateKeyToAccount(sessionPrivateKey);
        sessionKeyRef.current = {
          privateKey: sessionPrivateKey,
          address: sessionAccount.address,
        };
      }
      const { privateKey: sessionPrivateKey } = sessionKeyRef.current;
      const sessionSigner = createECDSAMessageSigner(sessionPrivateKey);

      const config = await fetchConfig(sessionPrivateKey);
      addLog(
        `Configuration fetched. Assets: ${config.assets?.length}, Networks: ${config.networks?.length}`,
      );

      const addresses = {
        custody: "0x019B65A265EB3363822f2752141b3dF16131b262",
        adjudicator: "0x7c7ccbc98469190849BCC6c926307794fDfB11F2",
      };

      const client = new NitroliteClient({
        publicClient,
        walletClient: walletClientState,
        stateSigner: new WalletStateSigner(walletClientState),
        addresses: addresses as any,
        chainId: selectedChainId,
        challengeDuration: 3600n,
      });

      addLog("✓ Nitrolite Client initialized");

      if (wsRef.current) wsRef.current.close();
      const ws = new WebSocket("wss://clearnet-sandbox.yellow.com/ws");
      wsRef.current = ws;

      const authParams = {
        session_key: sessionKeyRef.current.address,
        allowances: [
          {
            asset: "ytest.usd",
            amount: "1000000000",
          },
        ],
        expires_at: BigInt(Math.floor(Date.now() / 1000) + 3600),
        scope: "test.app",
      };

      const authRequestMsg = await createAuthRequestMessage({
        address: account,
        application: "Test app",
        ...authParams,
      });

      let isAuthenticated = false;

      ws.onopen = () => {
        ws.send(authRequestMsg);
        addLog("Sent auth_request (Requesting Wallet Signature...)");
        startHeartbeat();
      };

      ws.onmessage = async (event) => {
        const response = JSON.parse(event.data.toString());

        if (response.method === "pong") return;

        if (response.error) {
          if (response.id && typeof response.id === "number") return;
          addLog(`RPC Error: ${JSON.stringify(response.error)}`);
          stopHeartbeat();
          ws.close();
          setIsRunning(false);
          setStatus("Error");
          return;
        }

        if (response.res && response.res[1] === "auth_challenge") {
          if (isAuthenticated) return;
          addLog("Received auth_challenge");
          const challenge = response.res[2].challenge_message;

          const signer = createEIP712AuthMessageSigner(
            walletClientState,
            authParams,
            { name: "Test app" },
          );

          const verifyMsg = await createAuthVerifyMessageFromChallenge(
            signer,
            challenge,
          );
          ws.send(verifyMsg);
          addLog("Sent auth_verify (Signature approved)");
        }

        if (response.res && response.res[1] === "auth_verify") {
          addLog("✓ Authenticated successfully");
          isAuthenticated = true;

          const ledgerMsg = await createGetLedgerBalancesMessage(
            sessionSigner,
            account,
            Date.now(),
          );
          ws.send(ledgerMsg);
          addLog("Sent get_ledger_balances request...");
        }

        if (response.res && response.res[1] === "channels") {
          const channels = response.res[2].channels;
          const openChannel = channels.find(
            (c: any) =>
              c.status === "open" && Number(c.chain_id) === selectedChainId,
          );

          const supportedAsset = config.assets?.find(
            (a: any) => a.chain_id === selectedChainId,
          );
          const token = supportedAsset
            ? (supportedAsset as any).token
            : selectedChainId === sepolia.id
              ? "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"
              : undefined;

          if (!token) {
            addLog(`Error: No token found for chain ID ${selectedChainId}`);
            stopHeartbeat();
            ws.close();
            setIsRunning(false);
            setStatus("Error");
            return;
          }

          if (openChannel) {
            addLog("✓ Found existing open channel.");
            addLog(
              "Manual Action Required: Please Deposit Assets then Resize Channel.",
            );
            setActiveChannelInfo({
              id: openChannel.channel_id,
              token,
              client,
              publicClient,
            });
          } else {
            addLog(
              `No existing open channel found on chain ${selectedChainId}, creating new one...`,
            );
            const createChannelMsg = await createCreateChannelMessage(
              sessionSigner,
              { chain_id: selectedChainId, token: token },
            );
            ws.send(createChannelMsg);
          }
        }

        if (response.res && response.res[1] === "create_channel") {
          const { channel_id, state } = response.res[2];
          addLog(
            `✓ Channel prepared: ${channel_id}. Approving creation on L1...`,
          );

          const unsignedInitialState = {
            intent: state.intent,
            version: BigInt(state.version),
            data: state.state_data,
            allocations: state.allocations.map((a: any) => ({
              destination: a.destination,
              token: a.token,
              amount: BigInt(a.amount),
            })),
          };

          const createResult = await client.createChannel({
            channel: response.res[2].channel,
            unsignedInitialState,
            serverSignature: response.res[2].server_signature,
          });

          const txHash =
            typeof createResult === "string"
              ? createResult
              : (createResult as any).txHash;
          addLog(`✓ Channel created on-chain: ${txHash}`);
          addLog("  Waiting for transaction confirmation...");
          await publicClient.waitForTransactionReceipt({ hash: txHash });
          addLog("✓ Transaction confirmed.");

          const token = state.allocations[0].token;
          addLog(
            "Manual Action Required: Please Deposit Assets then Resize Channel.",
          );
          setActiveChannelInfo({ id: channel_id, token, client, publicClient });
        }

        if (response.res && response.res[1] === "resize_channel") {
          const { channel_id, state, server_signature } = response.res[2];
          addLog("✓ Resize prepared. Waiting for off-chain funding...");

          const resizeState = {
            intent: state.intent,
            version: BigInt(state.version),
            data: state.state_data || state.data,
            allocations: state.allocations.map((a: any) => ({
              destination: a.destination,
              token: a.token,
              amount: BigInt(a.amount),
            })),
            channelId: channel_id,
            serverSignature: server_signature,
          };

          const token = resizeState.allocations[0].token;
          const requiredAmount = resizeState.allocations.reduce(
            (sum: bigint, a: any) => {
              if (a.token === token) return sum + BigInt(a.amount);
              return sum;
            },
            0n,
          );

          addLog(
            `Waiting for user to fund Custody (Required: ${requiredAmount})...`,
          );

          let userBalance = 0n;
          let retries = 0;
          while (retries < 30) {
            try {
              const result = (await publicClient.readContract({
                address: client.addresses.custody,
                abi: [
                  {
                    type: "function",
                    name: "getAccountsBalances",
                    inputs: [
                      { name: "users", type: "address[]" },
                      { name: "tokens", type: "address[]" },
                    ],
                    outputs: [{ type: "uint256[]" }],
                    stateMutability: "view",
                  },
                ] as const,
                functionName: "getAccountsBalances",
                args: [[account], [token as `0x${string}`]],
              })) as bigint[];
              userBalance = result[0];
            } catch (e) {
              addLog(`Error checking balance: ${e}`);
            }

            if (userBalance >= requiredAmount) break;
            await new Promise((r) => setTimeout(r, 2000));
            retries++;
            if (retries % 5 === 0)
              addLog(`User Balance: ${userBalance}, Waiting...`);
          }

          addLog("Submitting resize to L1 (Approving Wallet Transaction)...");
          const { txHash } = await client.resizeChannel({
            resizeState,
            proofStates: [],
          });

          addLog(`✓ Channel resized on-chain: ${txHash}`);
          await new Promise((r) => setTimeout(r, 3000));

          addLog(`Closing channel: ${channel_id}`);
          const closeMsg = await createCloseChannelMessage(
            sessionSigner,
            channel_id as `0x${string}`,
            account,
          );
          ws.send(closeMsg);
        }

        if (response.res && response.res[1] === "close_channel") {
          const { channel_id, state, server_signature } = response.res[2];
          addLog("✓ Close prepared. Approving Wallet Transaction...");

          const txHash = await client.closeChannel({
            finalState: {
              intent: state.intent,
              version: BigInt(state.version),
              data: state.state_data || state.data,
              allocations: state.allocations.map((a: any) => ({
                destination: a.destination,
                token: a.token,
                amount: BigInt(a.amount),
              })),
              channelId: channel_id,
              serverSignature: server_signature,
            },
            stateData: state.state_data || state.data || "0x",
          });

          addLog(`✓ Channel closed on-chain: ${txHash}`);
          addLog("Withdrawing funds...");
          const token = state.allocations[0].token;
          await new Promise((r) => setTimeout(r, 2000));

          const result = (await publicClient.readContract({
            address: client.addresses.custody,
            abi: [
              {
                type: "function",
                name: "getAccountsBalances",
                inputs: [
                  { name: "users", type: "address[]" },
                  { name: "tokens", type: "address[]" },
                ],
                outputs: [{ type: "uint256[]" }],
                stateMutability: "view",
              },
            ] as const,
            functionName: "getAccountsBalances",
            args: [[account], [token as `0x${string}`]],
          })) as bigint[];
          const balance = result[0];

          if (balance > 0n) {
            addLog(`Withdrawing ${balance} of ${token}...`);
            const withdrawalTx = await client.withdrawal(
              token as `0x${string}`,
              balance,
            );
            addLog(`✓ Funds withdrawn: ${withdrawalTx}`);
          } else {
            addLog("No funds to withdraw.");
          }

          stopHeartbeat();
          setStatus("Completed");
          setIsRunning(false);
          ws.close();
        }
      };

      ws.onerror = (error) => {
        addLog(`WebSocket Error: ${JSON.stringify(error)}`);
        stopHeartbeat();
        ws.close();
        setIsRunning(false);
        setStatus("Error");
      };

      ws.onclose = () => {
        stopHeartbeat();
        addLog("WebSocket connection closed.");
      };
    } catch (error: any) {
      addLog(`Error: ${error.message || error}`);
      setIsRunning(false);
      setStatus("Error");
    }
  };

  return (
    <div
      className="container"
      style={{
        padding: "20px",
        maxWidth: "800px",
        margin: "0 auto",
        fontFamily: "monospace",
      }}
    >
      <h1>Nitrolite Integration</h1>

      <div
        style={{
          marginBottom: "20px",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
        }}
      >
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <button
            onClick={connectWallet}
            style={{
              padding: "10px 20px",
              backgroundColor: account ? "#28a745" : "#6c757d",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
              flex: 1,
            }}
          >
            {account
              ? `Connected: ${account.slice(0, 6)}...${account.slice(-4)}`
              : "Connect Wallet"}
          </button>
          {account && (
            <button
              onClick={() => {
                setAccount(null);
                setStatus("Idle");
                setActiveChannelInfo(null);
                setIsDepositDone(false);
                stopHeartbeat();
                if (wsRef.current) wsRef.current.close();
              }}
              style={{
                padding: "10px",
                backgroundColor: "#dc3545",
                color: "white",
                border: "none",
                borderRadius: "4px",
              }}
            >
              X
            </button>
          )}
        </div>

        <label>Select Network:</label>
        <select
          value={selectedChainId}
          onChange={(e) => setSelectedChainId(Number(e.target.value))}
          disabled={isRunning}
          style={{
            padding: "10px",
            borderRadius: "4px",
            border: "1px solid #ccc",
            width: "100%",
          }}
        >
          {SUPPORTED_CHAINS.map((chain) => (
            <option key={chain.id} value={chain.id}>
              {chain.name}
            </option>
          ))}
        </select>

        <button
          onClick={runFlow}
          disabled={isRunning || !account}
          style={{
            padding: "10px 20px",
            backgroundColor: isRunning || !account ? "#ccc" : "#007bff",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: isRunning || !account ? "not-allowed" : "pointer",
            marginTop: "10px",
          }}
        >
          {isRunning ? "Running..." : "Start Flow"}
        </button>

        {activeChannelInfo && (
          <div style={{ display: "flex", gap: "10px", marginTop: "5px" }}>
            <button
              onClick={handleDeposit}
              disabled={isDepositing || isDepositDone}
              style={{
                padding: "15px 20px",
                backgroundColor:
                  isDepositing || isDepositDone ? "#ccc" : "#ffc107",
                color: "black",
                fontWeight: "bold",
                borderRadius: "4px",
                cursor:
                  isDepositing || isDepositDone ? "not-allowed" : "pointer",
                flex: 1,
                border: "2px solid #e0a800",
              }}
            >
              {isDepositing
                ? "Depositing..."
                : isDepositDone
                  ? "✓ Assets Deposited"
                  : "Step 1: Deposit Assets"}
            </button>

            <button
              onClick={handleResize}
              disabled={isResizing}
              style={{
                padding: "15px 20px",
                backgroundColor: isResizing ? "#ccc" : "#28a745",
                color: "white",
                fontWeight: "bold",
                border: "none",
                borderRadius: "4px",
                cursor: isResizing ? "not-allowed" : "pointer",
                flex: 1,
                border: "2px solid #1e7e34",
              }}
            >
              {isResizing ? "Resizing..." : "Step 2: Resize Channel"}
            </button>
          </div>
        )}
      </div>

      <div style={{ marginBottom: "10px" }}>
        <strong>Status:</strong>{" "}
        <span
          style={{
            color:
              status === "Error"
                ? "red"
                : status === "Completed"
                  ? "green"
                  : "black",
          }}
        >
          {status}
        </span>
      </div>

      <div
        style={{
          backgroundColor: "#1e1e1e",
          color: "#d4d4d4",
          padding: "15px",
          borderRadius: "8px",
          height: "400px",
          overflowY: "auto",
        }}
      >
        {logs.length === 0 && (
          <div style={{ color: "#666" }}>Logs will appear here...</div>
        )}
        {logs.map((log, i) => (
          <div
            key={i}
            style={{
              marginBottom: "5px",
              borderBottom: "1px solid #333",
              paddingBottom: "2px",
            }}
          >
            {log}
          </div>
        ))}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}
