import { test } from "node:test";
import { Server } from "ssh2";
import { createHash } from "node:crypto";
import { pullFromDevice, buildPullCommand } from "../src/device/pull";
import { parseTar } from "../src/device/tar";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mapRemotePath, assertCacheReady, recoverCachePromotion, promotePull, readObject, sha256, CacheLock, readCacheSizes } from "../src/device/cache";

test("remote mapping rejects traversal before normalization", () => {
 for (const remote of ["mnt/us/documents/../../cc.db", "mnt/us/documents/../thumbnails/x", "mnt/us/documents/a/../x", "mnt/us/documents/./x", "mnt/us/documents/a\\b", "mnt/us/documents/a\u0000b"]) assert.equal(mapRemotePath(remote), null);
});

for (const bad of [
 { files: [] }, { files: null }, { files: {} }, { host: undefined }, { host: 42 }, { host: "" },
 { takenAt: undefined }, { takenAt: "" }, { takenAt: "not a date" }, { manifestName: 42 },
 { files: { "var/local/cc.db": 42 } }, { files: { "var/local/cc.db": "bad" } },
 { files: { "mnt/us/documents/../cc.db": "a".repeat(64) } },
]) test(`invalid promotion journal is immutable: ${JSON.stringify(bad)}`, () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), "invalid-journal-"));
 try {
  const bytes = Buffer.from("new"); const digest = sha256(bytes);
  fs.mkdirSync(path.join(root, "raw-objects")); fs.writeFileSync(path.join(root, "raw-objects", digest), bytes);
  const { manifestName = "snapshot.json", ...fields } = bad;
  const journal = path.join(root, ".pending-promotion.json");
  const text = JSON.stringify({ manifestName, manifest: { host: "k", takenAt: "2026-01-01T00:00:00.000Z", files: { "mnt/us/documents/new/book": digest }, ...fields } });
  fs.writeFileSync(journal, text); fs.writeFileSync(path.join(root, "cc.db"), "old");
  assert.throws(() => recoverCachePromotion(root), /Invalid promotion/);
  assert.equal(fs.readFileSync(journal, "utf8"), text);
  assert.deepEqual(fs.readdirSync(root).sort(), [".pending-promotion.json", "cc.db", "raw-objects"]);
  assert.equal(fs.readFileSync(path.join(root, "cc.db"), "utf8"), "old");
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the pull command tars optional fmcache.db and requires clippings", () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(),"pull-command-"));
 const command = buildPullCommand().replaceAll("/mnt",`${root}/mnt`).replaceAll("/var",`${root}/var`);
 const members = () => parseTar(execFileSync("sh",["-c",command],{stdio:["ignore","pipe","ignore"],maxBuffer:1<<24})).map(e => "/" + e.name.slice(root.length));
 try {
  for (const dir of ["var/local","mnt/us/system/vocabulary","mnt/us/system/thumbnails","mnt/us/documents/Book.sdr"]) fs.mkdirSync(path.join(root,dir),{recursive:true});
  for (const file of ["var/local/cc.db","mnt/us/system/vocabulary/vocab.db","mnt/us/documents/My Clippings.txt","mnt/us/documents/Book.sdr/Book.azw3f"]) fs.writeFileSync(path.join(root,file),"x");
  assert.ok(!members().some(m => m.includes("fmcache")));
  fs.mkdirSync(path.join(root,"mnt/us/system/fmcache"));
  fs.writeFileSync(path.join(root,"mnt/us/system/fmcache/fmcache.db"),"db");
  assert.ok(members().includes("/mnt/us/system/fmcache/fmcache.db"));
  assert.ok(members().includes("/mnt/us/documents/Book.sdr/Book.azw3f"));
  fs.unlinkSync(path.join(root,"mnt/us/documents/My Clippings.txt"));
  assert.throws(members, "a missing clippings file fails the remote command");
 } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

function tarFile(name: string, text: string): Buffer {
 const h = Buffer.alloc(512); h.write(name);
 h.write("0000600\0",100); h.write("0000000\0",108); h.write("0000000\0",116);
 h.write(text.length.toString(8).padStart(11,"0")+"\0",124);
 h.write("00000000000\0",136); h.fill(32,148,156); h.write("0",156);
 h.write(h.reduce((n,b)=>n+b,0).toString(8).padStart(6,"0")+"\0 ",148);
 const body = Buffer.alloc(Math.ceil(text.length/512)*512); body.write(text);
 return Buffer.concat([h,body]);
}

for (const scenario of ["ok", "bytes-limit", "entries-limit", "clippings-error", "no-clippings"]) {
 test(`pull safety: ${scenario}`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"pull-safe-"));
  const key = path.join(__dirname,"fixtures/ssh/host_ed25519");
  const fingerprint = "SHA256:"+createHash("sha256").update(Buffer.from(fs.readFileSync(key+".pub","utf8").split(" ")[1],"base64")).digest("base64").replace(/=+$/,"");
  const archive = Buffer.concat([tarFile("var/local/cc.db","cc"),...(scenario === "no-clippings" ? [] : [tarFile("mnt/us/documents/My Clippings.txt","clips")]),Buffer.alloc(1024)]);
  const server = new Server({hostKeys:[fs.readFileSync(key)]}, client => {
   client.on("error",()=>{});
   client.on("authentication",ctx=>ctx.method === "password" ? ctx.accept() : ctx.reject(["password"]));
   client.on("ready",()=>client.on("session",accept=>accept().on("exec",acceptExec=>{
    const stream = acceptExec();
    calls++;
    stream.write(archive);
    stream.exit(0); stream.end();
   })));
  });
  let calls = 0;
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  let lock: CacheLock | undefined;
  try {
   promotePull(root,[{remote:"mnt/us/system/fmcache/fmcache.db",bytes:Buffer.from("previous")}],{host:"k"});
   if(scenario === "clippings-error") fs.mkdirSync(path.join(root,"documents/My Clippings.txt"),{recursive:true});
   lock = CacheLock.acquire(root);
   const run = () => pullFromDevice({cacheRoot:root,settings:{kindleHost:`127.0.0.1:${(server.address() as {port:number}).port}`,kindleUser:"root",kindlePassword:"kindle",kindleHostFingerprint:fingerprint,syncTimeoutSeconds:5},limits:scenario === "bytes-limit" ? {maxArchiveBytes:1} : scenario === "entries-limit" ? {maxEntries:1} : {}});
   if(scenario === "ok") {
    await run(); assert.equal(calls, 1, "one SSH exec per pull");
    assert.equal(fs.readFileSync(path.join(root,"cc.db"),"utf8"),"cc");
    // Like any file the device no longer sends, the previous copy stays.
    assert.equal(fs.readFileSync(path.join(root,"fmcache.db"),"utf8"),"previous");
    assert.equal(fs.existsSync(path.join(root,".lock")),true, "the caller keeps its lock");
   } else {
    await assert.rejects(run, scenario === "clippings-error" ? /EISDIR/ : scenario === "no-clippings" ? /My Clippings\.txt/ : /limit exceeded/);
    assert.equal(fs.readFileSync(path.join(root,"fmcache.db"),"utf8"),"previous");
    assert.equal(fs.existsSync(path.join(root,"cc.db")),false);
   }
  } finally { lock?.release(); await new Promise<void>(resolve=>server.close(()=>resolve())); fs.rmSync(root,{recursive:true,force:true}); }
 });
}

for (const stage of ["objects", "journal", "manifest", "file:cc.db", "file:vocab.db", "complete"]) {
 test(`promotion interrupted at ${stage} rolls forward durably`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "promotion-"));
  try {
   const old = Buffer.from("old fmcache");
   promotePull(root, [{remote:"mnt/us/system/fmcache/fmcache.db", bytes:old}], {host:"k"});
   const files = [{remote:"var/local/cc.db",bytes:Buffer.from("cc")}, {remote:"mnt/us/system/vocabulary/vocab.db",bytes:Buffer.from("vocab")}];
   assert.throws(() => promotePull(root, files, {host:"k", onPromotionStage(s) { if(s === stage) throw Error("interrupted"); }}), /interrupted/);
   if (stage !== "objects" && stage !== "complete") assert.throws(() => assertCacheReady(root), /pending promotion/i);
   if (["manifest", "file:cc.db", "file:vocab.db"].includes(stage)) {
    assert.throws(() => recoverCachePromotion(root, s => { if(s === stage) throw Error("recovery interrupted"); }), /recovery interrupted/);
    assert.throws(() => assertCacheReady(root), /pending promotion/i);
   }
   recoverCachePromotion(root);
   recoverCachePromotion(root);
   assertCacheReady(root);
   if(stage !== "objects") {
    assert.equal(fs.readFileSync(path.join(root,"cc.db"),"utf8"), "cc");
    assert.equal(fs.readFileSync(path.join(root,"vocab.db"),"utf8"), "vocab");
   }
   assert.equal(fs.readFileSync(path.join(root,"fmcache.db"),"utf8"), "old fmcache");
   assert.deepEqual(Buffer.from(readObject(root,sha256(old))),old);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
 });
}

test("cache size reporting counts objects", async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(),"cache-sizes-"));
 try {
  promotePull(root,[{remote:"var/local/cc.db",bytes:Buffer.from("cc")}],{host:"k"});
  const sizes = await readCacheSizes(root);
  assert.equal(sizes.objectCount,1); assert.equal(sizes.objectStoreBytes,2); assert.equal(sizes.archiveBytes,0);
 } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test("corrupt objects leave recovery blocked without changing live files", () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(),"cache-corrupt-"));
 try {
  const bytes = Buffer.from("new");
  fs.writeFileSync(path.join(root,"cc.db"),"old");
  assert.throws(()=>promotePull(root,[{remote:"var/local/cc.db",bytes}],{host:"k",onPromotionStage(s){if(s === "journal") throw Error("stop");}}),/stop/);
  fs.writeFileSync(path.join(root,"raw-objects",sha256(bytes)),"corrupt");
  assert.throws(()=>recoverCachePromotion(root),/Corrupt raw object/);
  assert.throws(()=>assertCacheReady(root),/pending promotion/i);
  assert.equal(fs.readFileSync(path.join(root,"cc.db"),"utf8"),"old");
 } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test("cache accepts a symlinked root, e.g. moved to another disk", () => {
 const parent = fs.mkdtempSync(path.join(os.tmpdir(),"cache-link-"));
 try {
  const root = path.join(parent,"cache");
  CacheLock.acquire(root).release();
  fs.symlinkSync(root,path.join(parent,"link"));
  CacheLock.acquire(path.join(parent,"link")).release();
  fs.writeFileSync(path.join(parent,"file"),"");
  assert.throws(()=>CacheLock.acquire(path.join(parent,"file")), /Not a directory/);
 } finally { fs.rmSync(parent,{recursive:true,force:true}); }
});
