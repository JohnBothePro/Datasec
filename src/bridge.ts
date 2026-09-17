/**
 * DOKU@WEB Bridge info (API Kap. 1) — share-folder polling, no mass upload.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

export function bridgeInfo(opts?: {
  listPath?: boolean;
  confirm?: boolean;
}): Record<string, unknown> {
  const sharePath = process.env.BRIDGE_SHARE_PATH?.trim() || null;
  const result: Record<string, unknown> = {
    ok: true,
    section: "Kap. 1 DOKU@WEB Bridge",
    approach:
      "Externe Apps legen Objekte in einem Share (Freigabeverzeichnis) ab. " +
      "Die Bridge pollt das Verzeichnis und archiviert gültige Objekte (sie verschwinden danach). " +
      "Nur über VPN erreichbar. Kein massenhaftes Hochladen über die API — Share + Indexdateien.",
    standardShares: [
      "dwready — bereitgestellte Objekte",
      "Stammdat_in — Stammdaten abholen",
      "Stammdat_out — neue Stammdaten einspielen",
    ],
    uncPattern: "\\\\<Hostname der Bridge>\\<Name des Shares>",
    warning:
      "Kein Dauer-Schreiben / Massen-Upload in den Share — kann Bridge-Funktionen stören.",
    BRIDGE_SHARE_PATH: sharePath,
    massUpload: "disabled — requires write+confirm and is not implemented as bulk API",
  };

  if (opts?.listPath && sharePath) {
    const abs = resolve(sharePath);
    if (!existsSync(abs)) {
      result.pathCheck = { ok: false, path: abs, error: "path does not exist" };
    } else {
      try {
        const st = statSync(abs);
        if (!st.isDirectory()) {
          result.pathCheck = { ok: false, path: abs, error: "not a directory" };
        } else {
          const entries = readdirSync(abs).slice(0, 50);
          result.pathCheck = {
            ok: true,
            path: abs,
            entryCountShown: entries.length,
            entries,
            note: "Listing capped at 50; no upload performed.",
          };
        }
      } catch (e) {
        result.pathCheck = {
          ok: false,
          path: abs,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }
  } else if (opts?.listPath && !sharePath) {
    result.pathCheck = {
      ok: false,
      error: "BRIDGE_SHARE_PATH env not set — cannot list",
    };
  }

  return result;
}
