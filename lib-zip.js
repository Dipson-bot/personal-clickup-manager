// Minimal ZIP writer (store, no compression) used by the Admin panel to package
// this extension's own files into the release zip. Chrome can read the files it
// runs from, so the package is built entirely in the browser - no build step and
// nothing to install. Plain script (not a module): it exposes window.pcmZip.
(function () {
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  // MS-DOS date/time, as the zip format wants it.
  function dosTime(d) {
    return {
      time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31),
      date: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
    };
  }

  // files: [{ path, data: Uint8Array }] -> Blob (application/zip)
  function makeZip(files, when) {
    const enc = new TextEncoder();
    const stamp = dosTime(when || new Date());
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.path);
      const data = f.data;
      const sum = crc32(data);
      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); // local file header
      lv.setUint16(4, 20, true);         // version needed
      lv.setUint16(6, 0, true);          // flags
      lv.setUint16(8, 0, true);          // method 0 = stored
      lv.setUint16(10, stamp.time, true);
      lv.setUint16(12, stamp.date, true);
      lv.setUint32(14, sum, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);
      chunks.push(local, data);

      const dir = new Uint8Array(46 + name.length);
      const dv = new DataView(dir.buffer);
      dv.setUint32(0, 0x02014b50, true); // central directory header
      dv.setUint16(4, 20, true);         // version made by
      dv.setUint16(6, 20, true);         // version needed
      dv.setUint16(8, 0, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, stamp.time, true);
      dv.setUint16(14, stamp.date, true);
      dv.setUint32(16, sum, true);
      dv.setUint32(20, data.length, true);
      dv.setUint32(24, data.length, true);
      dv.setUint16(28, name.length, true);
      dv.setUint32(42, offset, true);    // where its local header starts
      dir.set(name, 46);
      central.push(dir);
      offset += local.length + data.length;
    }
    let centralSize = 0;
    for (const c of central) centralSize += c.length;
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);   // end of central directory
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, end], { type: "application/zip" });
  }

  window.pcmZip = { makeZip };
})();
