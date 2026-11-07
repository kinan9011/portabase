import {createHash} from "node:crypto";
import type {KitDocument} from "./material";

/**
 * Paper kit (D25 (i), §4.2): ONE complete HTML document, rendered server-side for a single response (`no-store`, see the route handler), never part of a
 * page, RSC payload, query cache or storage. Keys are printed as base32 (RFC 4648 alphabet: no 0/1/8/9, so no O/0 or I/1 confusion) in groups of four with a
 * per-line checksum, so a typo is caught when the operator retypes the lines into the verifier (W14b):
 *   `LABEL n:  GGGG GGGG GGGG GGGG  ·  CC`    CC = first two base32 chars of SHA-256("pbkit1|LABEL|n|<line chars without spaces>")
 * The verification code is NOT printed (ADR-013 §8). No QR code: no QR library is in the dependency tree (recorded deviation, ADR-006).
 */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(buf: Buffer): string {
    let bits = 0; let value = 0; let out = "";
    for (const b of buf) {
        value = (value << 8) | b; bits += 8;
        while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
}
export function lineCheck(label: string, n: number, chars: string): string {
    return base32(createHash("sha256").update(`pbkit1|${label}|${n}|${chars}`).digest()).slice(0, 2);
}
/** `[[line text, check], …]` for one key. */
export function keyLines(label: string, key: Buffer): {n: number; text: string; check: string}[] {
    const chars = base32(key);
    const lines: {n: number; text: string; check: string}[] = [];
    for (let i = 0, n = 1; i < chars.length; i += 16, n++) {
        const part = chars.slice(i, i + 16);
        lines.push({n, text: (part.match(/.{1,4}/g) as string[]).join(" "), check: lineCheck(label, n, part)});
    }
    return lines;
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c] as string));
const hexGroups = (h: string) => (h.toUpperCase().match(/.{1,4}/g) as string[]).join(" ");

export function renderPaperKit(kit: KitDocument, o: {nonce: string}): string {
    const keyBlock = (label: string, title: string, key: Buffer, note = "") =>
        `<h2>${esc(title)}</h2>${note ? `<p class="note">${esc(note)}</p>` : ""}<pre class="key">${keyLines(label, key).map((l) => `${esc(label)} ${l.n}:  ${l.text}  ·  ${l.check}`).join("\n")}</pre>`;
    const master = Buffer.from(kit.master_key_b64, "base64");
    const kekBlocks = kit.kek.keys.map((k) => keyBlock(`KEK-${k.kid}`, `Fork key ${k.kid}${k.kid === kit.kek.active ? " (active)" : ""}`, Buffer.from(k.key_b64, "base64"))).join("");
    const anchors = kit.signing_public_keys.map((a) => `<li><code>${esc(a.kid)}</code>${a.retired ? " (retired)" : " (current)"} — SHA-256 <code>${esc(hexGroups(a.spki_sha256))}</code></li>`).join("");
    const storage = kit.storage.map((s) => `<li><strong>${esc(s.name)}</strong> (${esc(s.provider)}) — ${esc(Object.entries(s.pointer).map(([k, v]) => `${k}=${String(v)}`).join(", ") || "no location fields")}${s.credentials_wrapped ? " · wrapped credentials: see the digital kit" : ""}</li>`).join("") || "<li>No storage channel is in use yet.</li>";
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer">
<title>Portabase recovery kit — paper</title>
<style nonce="${o.nonce}">body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#111;background:#fff}h1{font-size:22px}h2{font-size:16px;margin:20px 0 4px}pre.key{font:600 16px/1.9 ui-monospace,Menlo,Consolas,monospace;background:#f4f4f4;padding:12px;border:1px solid #999;letter-spacing:.04em;overflow:auto}code{font-family:ui-monospace,Menlo,Consolas,monospace}.warn{border:3px solid #b00020;padding:12px;font-weight:700;margin:12px 0}.note{color:#444;margin:0 0 6px}button{font:inherit;padding:8px 14px;margin:8px 0}@media print{button,.noprint{display:none}body{margin:10mm}}</style></head>
<body>
<h1>Portabase recovery kit — paper</h1>
<p>Issued ${esc(kit.issued_at)} · kit format ${kit.kit_version}</p>
<p class="warn">Anyone with this paper can read your backups. Keep it offline, in a sealed place, away from the server it protects. This page is shown once and is not stored.</p>
<p class="noprint"><button type="button" id="print">Print this page</button> You cannot reopen it: if you leave without printing, generate a new kit.</p>
${keyBlock("MASTER", "Master key (reads every backup)", master, "Retype these lines into the verifier; the two letters after the dot are a typo check for that line.")}
${kekBlocks}
<h2>Signing keys (manifest verification)</h2><ul>${anchors}</ul>
<h2>Where the backups are</h2><ul>${storage}</ul>
<h2>Recovery tool</h2><p>Recover image: ${esc(kit.recover.image_digest)} · CLI version: ${esc(kit.recover.cli_version)} · Guide: ${esc(kit.recover.guide)}</p>
<p class="note">After printing, run the offline verifier on this paper and enter the code it prints in the dashboard (Recovery kit page). Until then the dashboard reports “Recovery kit not verified”.</p>
<script nonce="${o.nonce}">document.getElementById("print").addEventListener("click",function(){window.print()});</script>
</body></html>`;
}
