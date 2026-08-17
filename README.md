# ClassicStackWeb

Browser AppleTalk / AFP stack over **WebSerial → TashTalk → LocalTalk**.

## Features

- Connect a TashTalk USB serial adaptor (1 Mbaud, RTS/CTS) from Chrome/Edge
- Act as an **AFP server** sharing one IndexedDB-backed volume (`Browser Share`) to classic Macs
- **NBP** discovery of remote `AFPServer` hosts
- Act as an **AFP client** to browse/upload/download/rename/delete on remote shares
- **Netboot** (AppleTalk Boot Protocol + ChainBoot EBP): bundled `ChainLoader.bin`, downloadable `BootstrapFloppy.dsk`, user-selected System HFS; advertise as `BootServer`
- Bundled **welcome pack** (`public/welcome/`) auto-imported into Browser Share; restore via sidebar **Add Welcome Pack Items**
- AppleSingle / AppleDouble import; zip downloads default to AppleDouble `._` pairs (Advanced → **Mac OS X zip** uses a `__MACOSX` folder instead)
- Finder-style UI: icon / list / column views, properties (type/creator)
- Advanced → **Extension editor…** maps filename suffixes to Macintosh creator/type plus a comment (saved in localStorage; used on import when there is no AppleDouble metadata)
- Dropped BinHex (`.hqx`), MacBinary (`.bin`), StuffIt (`.sit`), and ZIP (`.zip`) are decoded into the inner Macintosh files (name, forks, type/creator); ZIP merges `._` and `__MACOSX` AppleDouble. Toggle via Advanced → **Auto-expand files**
- Resource-fork icons (BNDL / ICN# / icl8) with `./icons` system fallbacks and a clearable local type-icon cache
- Advanced → **Resource Fork…** (or Get Info / context menu **Resources…**) lists every resource type, id, and BNDL mapping in the selected file

## Requirements

- Chromium browser with [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)
- TashTalk hardware on LocalTalk
- Node 20+ for development
- For Netboot: a classic Mac (use Advanced → Netboot… → Download for `BootstrapFloppy.dsk` to enable XPRAM); provide an HFS System volume to stream

## Develop

```bash
npm install
npm run dev
```

Open the printed localhost URL, click **Connect TashTalk**, pick the TashTalk port.

```bash
npm test
npm run build
```

## Architecture

See the plan: TashTalk → LLAP/DDP → NBP → ATP → ASP → AFP, with a VirtualFS + Desktop DB for the local share. Netboot rides DDP type 10 on sockets 10/11 beside AFP.

Protocol codecs mirror [ClassicStack](https://github.com/ObsoleteMadness/ClassicStack).

Finder UI (`src/ui/finder-window.ts`) must stay independent of archive and resource-fork codecs. StuffIt, BinHex, MacBinary, ZIP, Apple compressed resources (`dcmp`), icon/BNDL decoders, and any future **rez** decompiler live under `src/fs/` and register through `src/fs/codecs.ts` (`classicstack-web/fs/codecs`). When this repo splits into packages, those modules become their own packages (`@classicstack/finder-ui`, `@classicstack/expand`, `@classicstack/stuffit`, `@classicstack/resource-fork`, …) so a third party can ship a replacement SIT expander or rez decoder without forking the PWA.

The Finder sidebar layout is owned by the host: set `RemoteEndpoint.group` / `badge` and implement `FinderHost.sidebarGroups()`. ClassicStack groups local shares vs AppleTalk / SMB / NetWare / EtherDFS clients; the TashTalk PWA keeps a single LocalTalk list.

Register with `registerArchiveCodec`, `registerResourceDecompressor`, `registerResourceTypeDecoder`, or `registerRezCodec`. Re-registering the bundled ids (`sit`, `binhex`, `macbinary`, `zip`, `applesingle`, `dcmp`) replaces the default implementation.

## Credits

ClassicStack is indebted to the following source code and authors:

- [Tashtari](https://github.com/lampmerchant) for [TashTalk](https://github.com/lampmerchant/tashtalk) (host framing also follows [TashRouter](https://github.com/lampmerchant/tashrouter); GPLv3)
- [Elliot Nunn](https://github.com/elliotnunn) for [NetBoot](https://github.com/elliotnunn/NetBoot) (ChainLoader / AppleTalk Boot Protocol; MIT)
- [XADMaster](https://github.com/MacPaw/XADMaster) / The Unarchiver — [Dag Ågren](https://github.com/DagAgren), [Dirk Stöcker](https://www.dstoecker.eu/xadmaster.html), and the xadmaster library — StuffIt archive formats (also via [stuffit-rs](https://github.com/benletchford/stuffit-rs))
- [Matthias Wiesmann](https://github.com/wiesmann) for [QuickDrawViewer](https://github.com/wiesmann/QuickDrawViewer) (PICT / QuickDraw opcode layout and PackBits; Apache 2.0)
- [Harald Kuhr](https://github.com/haraldk) for [TwelveMonkeys](https://github.com/haraldk/TwelveMonkeys) [imageio-pict](https://github.com/haraldk/TwelveMonkeys/tree/master/imageio/imageio-pict) (PICT bitmap packing; BSD-3-Clause)

## Notes

- Guest login (`No User Authent`) plus `Cleartxt Passwrd` and Randnum UAMs when connecting as a client
- Resource-fork icon decoder (ICN# / icl8 / BNDL) for Finder icons; system glyphs from `./icons`; application type icons cached locally (Advanced → Clear icon cache)
- Resource Fork explorer (Advanced → Resource Fork…) dumps types, ids, BNDL/FREF mappings, and decoded icon previews from the selected file
- Desktop DB Add/GetIcon is implemented on the server
- AFP Write uses a simplified path; full WriteContinue parity may need tuning against specific Mac OS versions
- Netboot ChainBoot keeps the selected HFS image in browser memory for the session (writes are not persisted back to the file)
- Default Browser Share files live in `public/welcome/` (see that folder’s README); new pack files are imported on next load, archives are expanded (wrappers are not kept), existing names are never overwritten
