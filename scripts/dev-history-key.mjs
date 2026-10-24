// Unwraps a development profile's data key for scripts/dev-history.ts, since safeStorage needs Electron. Named and
// placed like the dev app (electron/identity.ts) so the same keychain entry opens. Prints the key as base64; exits 3
// when there is no usable keychain and 4 when the keychain does not open the key.
import { app, safeStorage } from "electron";

const [userData, wrapped] = process.argv.slice(-2);
app.setName("Endurance Dev");
app.setPath("userData", userData);
app.setPath("sessionData", userData);
app.dock?.hide();

const finish = (code, out = "") => process.stdout.write(out, () => app.exit(code));

app.whenReady().then(() => {
  if (!safeStorage.isEncryptionAvailable() || (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")) return finish(3);
  try {
    finish(0, safeStorage.decryptString(Buffer.from(wrapped, "base64")));
  } catch {
    finish(4);
  }
});
