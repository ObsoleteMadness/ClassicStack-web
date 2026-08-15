# Bundled welcome pack

Files in this folder (except this README, `LICENSE*`, and `manifest.json`) are copied into **Browser Share** on first launch, and again when the bundled file list changes.

Right-click **Browser Share** in the sidebar and choose **Add Welcome Pack Items** to restore anything the user deleted. Existing names are never overwritten.

## Adding utilities

Drop Mac files here (folders are preserved):

| Format | Notes |
|--------|--------|
| `Name.txt` | Imported as TeachText/SimpleText `Name` (AppleSingle, `TEXT`/`ttxt`) |
| AppleSingle | Detected by magic; keep the Mac filename |
| Data fork + `._Name` | AppleDouble sidecar merged on import |
| `.sit` / `.hqx` / `.bin` / `.zip` | Welcome-pack copies stay as-is. Drops decode `.hqx` / MacBinary `.bin` / StuffIt `.sit` / ZIP (including `._` and `__MACOSX` AppleDouble) by default (Advanced → **Auto-expand files**) |

Served at `/welcome/*` via Vite `public/`. The file list is generated as `/welcome/manifest.json`.
