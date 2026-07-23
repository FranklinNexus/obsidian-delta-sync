import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

import {
  GitHubApiError,
  GitHubClient,
  type RequestTransport,
  type TransportResponse,
} from "../src/github-client";

class RecordingTransport implements RequestTransport {
  readonly requests: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }[] = [];

  constructor(private readonly responses: TransportResponse[]) {}

  async request(options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<TransportResponse> {
    this.requests.push(options);
    const response = this.responses.shift();
    if (!response) throw new Error(`No scripted response for ${options.method} ${options.url}`);
    return response;
  }
}

function ok(json: unknown): TransportResponse {
  return { status: 200, json, text: JSON.stringify(json) };
}

function created(json: unknown): TransportResponse {
  return { status: 201, json, text: JSON.stringify(json) };
}

describe("GitHubClient", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("reads a recursive Git tree", async () => {
    const transport = new RecordingTransport([
      ok({ object: { sha: "head-1" } }),
      ok({ sha: "head-1", tree: { sha: "tree-1" } }),
      ok({
        sha: "tree-1",
        truncated: false,
        tree: [
          { path: "note.md", mode: "100644", type: "blob", sha: "blob-1", size: 4 },
          { path: "Folder", mode: "040000", type: "tree", sha: "tree-2" },
        ],
      }),
    ]);
    const client = new GitHubClient({
      owner: "owner",
      repository: "repo",
      branch: "feature/sync",
      token: "secret",
      transport,
    });
    const snapshot = await client.getSnapshot();
    expect(snapshot.commitSha).toBe("head-1");
    expect(snapshot.files.get("note.md")?.sha).toBe("blob-1");
    expect(transport.requests[0]?.url).toContain("/git/ref/heads/feature/sync");
    expect(transport.requests[0]?.headers.Authorization).toBe("Bearer secret");
  });

  it("creates one commit and updates the branch without force", async () => {
    const transport = new RecordingTransport([
      ok({ object: { sha: "head-1" } }),
      ok({ sha: "head-1", tree: { sha: "tree-1" } }),
      created({ sha: "blob-new" }),
      created({ sha: "tree-new" }),
      created({ sha: "head-2" }),
      ok({ object: { sha: "head-2" } }),
      ok({ object: { sha: "head-2" } }),
      ok({ sha: "head-2", tree: { sha: "tree-new" } }),
      ok({
        sha: "tree-new",
        truncated: false,
        tree: [{ path: "note.md", mode: "100644", type: "blob", sha: "blob-new", size: 5 }],
      }),
    ]);
    const client = new GitHubClient({
      owner: "owner",
      repository: "repo",
      branch: "main",
      token: "secret",
      transport,
    });
    const result = await client.commit(
      "head-1",
      [{ path: "note.md", kind: "put", bytes: new TextEncoder().encode("hello") }],
      "Sync",
    );
    expect(result.commitSha).toBe("head-2");
    const refUpdate = transport.requests.find((request) => request.method === "PATCH");
    expect(refUpdate).toBeDefined();
    expect(JSON.parse(refUpdate?.body ?? "{}")).toEqual({ sha: "head-2", force: false });
    expect(
      transport.requests.filter((request) => request.url.endsWith("/git/commits")),
    ).toHaveLength(1);
  });

  it("rejects a stale expected branch head before uploading blobs", async () => {
    const transport = new RecordingTransport([ok({ object: { sha: "head-new" } })]);
    const client = new GitHubClient({
      owner: "owner",
      repository: "repo",
      branch: "main",
      token: "secret",
      transport,
    });
    await expect(
      client.commit(
        "head-old",
        [{ path: "note.md", kind: "put", bytes: new TextEncoder().encode("hello") }],
        "Sync",
      ),
    ).rejects.toEqual(expect.objectContaining<Partial<GitHubApiError>>({ status: 409 }));
    expect(transport.requests).toHaveLength(1);
  });
});
