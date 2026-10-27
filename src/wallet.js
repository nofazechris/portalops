// Sending a ping to PortalPing from the visitor's OWN wallet (MetaMask, Rabby, anything that injects window.ethereum), with no library:
// the one call we need, ping(string), is encoded by hand and checked against viem in the tests. PortalOps never sees the key or the signature;
// the wallet signs and broadcasts, and the page then watches PortalOps capture the event.

export const PORTALDOT_CHAIN = {
  chainId: "0x190f1ca9", // 420420777
  chainName: "Portaldot V3.0 Testnet",
  rpcUrls: ["https://test-evm-rpc-v3.portaldot.dev"],
  nativeCurrency: { name: "tPOT", symbol: "tPOT", decimals: 18 },
};

/** keccak256("ping(string)")[0..4] */
export const PING_SELECTOR = "0x3adb191b";

const pad32 = (hex) => hex.padStart(64, "0");
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** ABI encoding of ping(note): selector, offset (0x20), byte length, then the UTF-8 bytes right-padded to a multiple of 32. */
export function encodePingCall(note) {
  const bytes = new TextEncoder().encode(String(note));
  const padded = toHex(bytes).padEnd(Math.ceil(bytes.length / 32) * 64, "0");
  return PING_SELECTOR + pad32("20") + pad32(bytes.length.toString(16)) + padded;
}

export const hasWallet = (w = typeof window !== "undefined" ? window : undefined) => !!w?.ethereum?.request;

/**
 * Connects the wallet, switches it to the Portaldot testnet (adding the network if it does not know it) and sends ping(note) to `contract`.
 * Resolves with the transaction hash. Rejections carry a message fit to show the visitor.
 */
export async function sendPingFromWallet(note, contract, eth = typeof window !== "undefined" ? window.ethereum : undefined) {
  if (!eth?.request) throw new Error("No wallet found in this browser. Install one (MetaMask, Rabby) or use the free ping above.");
  let accounts;
  try { accounts = await eth.request({ method: "eth_requestAccounts" }); }
  catch (e) { throw new Error(e?.code === 4001 ? "You closed the wallet before connecting." : "The wallet would not connect."); }
  if (!accounts?.[0]) throw new Error("The wallet did not share an account.");

  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: PORTALDOT_CHAIN.chainId }] });
  } catch (e) {
    if (e?.code !== 4902 && !/unrecognized|not added|unknown chain/i.test(String(e?.message))) throw new Error(e?.code === 4001 ? "You declined switching to the Portaldot testnet." : "The wallet could not switch to the Portaldot testnet.");
    try { await eth.request({ method: "wallet_addEthereumChain", params: [PORTALDOT_CHAIN] }); }
    catch (e2) { throw new Error(e2?.code === 4001 ? "You declined adding the Portaldot testnet." : "The wallet could not add the Portaldot testnet."); }
  }
  try {
    return await eth.request({ method: "eth_sendTransaction", params: [{ from: accounts[0], to: contract, data: encodePingCall(note), value: "0x0" }] });
  } catch (e) {
    if (e?.code === 4001) throw new Error("You rejected the transaction in your wallet.");
    if (/insufficient funds|gas required exceeds/i.test(String(e?.message))) throw new Error("This wallet has no testnet tPOT to pay for the transaction. Use the free ping instead.");
    throw new Error("The wallet could not send the transaction.");
  }
}
