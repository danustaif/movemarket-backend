// Penyimpanan vault passkey backup (SOT D27): satu file JSON di VAULT_DIR, dimuat saat start, ditulis atomik.
// Isi vault hanya ciphertext Mera; tetap jangan dicatat ke log.
import { SOT, type BackupVaultDto } from "@movemarket/shared";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type VaultStore = ReturnType<typeof createVaultStore>;

// ponytail: seluruh file ditulis ulang per perubahan (sinkron); cukup untuk maxPerAddress kecil dan penulisan jarang.
export function createVaultStore(dir: string) {
  const file = join(dir, SOT.account.backup.storageFile);
  mkdirSync(dir, { recursive: true });
  const data: Record<string, BackupVaultDto[]> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};

  /** tmp + rename: file lama utuh kalau proses mati di tengah penulisan. */
  function save() {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, file);
  }

  /** Ubah state lalu simpan; gagal simpan mengembalikan state di memori dan melempar (tidak ada data yang hanya ada di memori). */
  function commit(key: string, next: BackupVaultDto[]) {
    const prev = data[key];
    if (next.length) data[key] = next;
    else delete data[key];
    try {
      save();
    } catch (err) {
      if (prev) data[key] = prev;
      else delete data[key];
      throw err;
    }
  }

  return {
    list: (address: string): BackupVaultDto[] => [...(data[address.toLowerCase()] ?? [])],
    add(address: string, rec: BackupVaultDto) {
      const key = address.toLowerCase();
      commit(key, [...(data[key] ?? []), rec]);
    },
    /** false kalau id tidak ada. */
    remove(address: string, id: string): boolean {
      const key = address.toLowerCase();
      const cur = data[key] ?? [];
      const next = cur.filter((r) => r.id !== id.toLowerCase());
      if (next.length === cur.length) return false;
      commit(key, next);
      return true;
    },
  };
}
