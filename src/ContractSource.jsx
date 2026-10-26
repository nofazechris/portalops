import { useRef, useState } from "react";
import { ADDRESS_HELP, detectContractFile } from "./contractFile.js";
import { Field } from "./ui.jsx";

/**
 * "Tell PortalOps how to read this contract's events": Solidity (EVM) or Rust (ink!), by dropping the file the compiler wrote or pasting it.
 * The kind is detected from the file, so a developer never has to know the difference between an ABI and ink! metadata.
 * Controlled by the parent: it keeps `type` and `text`, and reads the result with buildContractBody() when the form is submitted.
 */
export function ContractSource({ type, setType, text, setText, error, optional = true }) {
  const [info, setInfo] = useState(null); // { ok, kind, events, note } | { ok: false, message }
  const [over, setOver] = useState(false);
  const input = useRef(null);

  function inspect(t) {
    if (!t.trim()) { setInfo(null); return; }
    try { const r = detectContractFile(t); setType(r.kind); setInfo({ ok: true, ...r }); }
    catch (e) { setInfo({ ok: false, message: e.message }); }
  }
  async function read(file) {
    if (!file) return;
    if (file.size > 2_000_000) { setInfo({ ok: false, message: "That file is over 2 MB. Upload the ABI or metadata JSON, not the compiled code." }); return; }
    const t = await file.text();
    setText(t); inspect(t);
  }

  return (
    <div className="cs">
      <div className="cs-type" role="radiogroup" aria-label="Contract language">
        {[["evm", "Solidity", "EVM"], ["ink", "Rust", "ink!"]].map(([id, name, tag]) => (
          <button key={id} type="button" role="radio" aria-checked={type === id} className={"cs-opt" + (type === id ? " on" : "")} onClick={() => setType(id)}>
            <b>{name}</b><span>{tag}</span>
          </button>
        ))}
      </div>
      <Field label={type === "ink" ? "ink! metadata file" : `ABI or compiler artifact${optional ? " (optional)" : ""}`} error={error}
        hint={type === "ink"
          ? "The metadata.json or .contract file that cargo contract build writes. PortalOps uses it to name and decode your events."
          : "Drop the ABI JSON, or a Hardhat / Foundry / Remix artifact. Without it, logs are stored raw and undecoded."}>
        <div className={"cs-drop" + (over ? " over" : "")} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); read(e.dataTransfer.files?.[0]); }}>
          <button type="button" className="btn secondary small" onClick={() => input.current?.click()}>Choose file</button>
          <span>or drop it here</span>
          <input ref={input} type="file" accept=".json,.contract,application/json" hidden onChange={(e) => { read(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
        <textarea className="textarea mono" style={{ marginTop: 8 }} value={text} onChange={(e) => { setText(e.target.value); inspect(e.target.value); }}
          placeholder={type === "ink" ? '{ "source": { … }, "spec": { "events": [ … ] }, … }' : '[{"type":"event","name":"QuestCreated", …}]'} spellCheck={false} />
      </Field>
      {info && (info.ok ? (
        <div className="cs-info ok">
          <b>{info.kind === "ink" ? "ink! (Rust) metadata" : "Solidity ABI"}</b>
          {info.events.length ? <> · {info.events.length} event{info.events.length === 1 ? "" : "s"}: <span className="mono">{info.events.slice(0, 6).join(", ")}{info.events.length > 6 ? ", …" : ""}</span></> : " · no events declared"}
          {info.note ? <div className="cs-note">{info.note}</div> : null}
        </div>
      ) : <div className="cs-info bad">{info.message}</div>)}
    </div>
  );
}

/**
 * The part of the "add contract" request that depends on the file: { type, abi }. Throws a readable Error when the text is not usable,
 * and when an ink! contract has no metadata (it cannot be decoded without it).
 */
export function buildContractBody(type, text) {
  if (!text.trim()) {
    if (type === "ink") throw new Error("An ink! contract needs its metadata file, so PortalOps can decode its events.");
    return { type: "evm" };
  }
  const r = detectContractFile(text);
  if (r.kind !== type) throw new Error(type === "ink" ? "That file is a Solidity ABI. Choose Solidity, or upload the ink! metadata." : "That file is ink! metadata. Choose Rust (ink!), or upload a Solidity ABI.");
  return { type: r.kind, abi: r.abi };
}

export { ADDRESS_HELP };
