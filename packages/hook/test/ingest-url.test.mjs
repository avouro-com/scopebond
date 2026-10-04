import { test } from "node:test";
import assert from "node:assert/strict";
import { ingestUrl } from "../dist/index.js";

const url = "https://cloud.example.com";

test("records go to the workspace URL when the enrollment named no ingest address", () => {
  assert.equal(ingestUrl({ url }), url);
});

test("records go to the regional ingest origin the enrollment named", () => {
  assert.equal(ingestUrl({ url, ingest_url: "https://eu.ingest.example.com/" }), "https://eu.ingest.example.com");
  assert.equal(ingestUrl({ url, ingest_url: "http://localhost:8787" }), "http://localhost:8787");
});

test("an unsafe or malformed ingest address is ignored, never used", () => {
  for (const bad of ["http://eu.ingest.example.com", "https://user:pw@eu.ingest.example.com", "not a url", "ftp://x.example.com", 42]) {
    assert.equal(ingestUrl({ url, ingest_url: bad }), url, String(bad));
  }
});
