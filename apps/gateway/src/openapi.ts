const tenantHeaders = [
  "X-Mekka-Organization-Id",
  "X-Mekka-Project-Id",
  "X-Mekka-Environment-Id",
  "X-Mekka-Branch-Id",
  "X-Mekka-Generation",
].map((name) => ({ name, in: "header", required: true, schema: { type: "string" } }));

const storagePathParameters = [
  { name: "bucket", in: "path", required: true, schema: { type: "string" } },
  { name: "path", in: "path", required: true, schema: { type: "string" } },
];

export const openApiDocument = Object.freeze({
  openapi: "3.1.0",
  info: { title: "Mekka Gateway API", version: "0.3.0" },
  paths: {
    "/rest/v1/{table}": {
      get: {
        summary: "Select rows from a policy-authorized table",
        parameters: [
          { name: "table", in: "path", required: true, schema: { type: "string" } },
          { name: "Range-Unit", in: "header", schema: { type: "string", enum: ["items"] } },
          { name: "Range", in: "header", schema: { type: "string", example: "0-24" } },
          { name: "Prefer", in: "header", schema: { type: "string", example: "count=exact" } },
        ],
        responses: {
          "200": { description: "JSON array with an unknown total count" },
          "206": { description: "JSON array with Prefer: count=exact" },
          "400": { description: "Invalid tenant, query, range or preference" },
          "403": { description: "Policy or tenant authorization denied" },
          "413": { description: "Response byte cap exceeded" },
          "429": { description: "Request rate or query row cap exceeded" },
          "503": { description: "Query deadline or infrastructure failure" },
        },
      },
      post: {
        summary: "Insert one row or primary-key upsert with resolution=merge-duplicates",
        parameters: [
          { name: "table", in: "path", required: true, schema: { type: "string" } },
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } },
          {
            name: "Prefer",
            in: "header",
            schema: { type: "string", example: "return=representation" },
          },
        ],
        responses: {
          "201": { description: "Created row representation" },
          "204": { description: "Mutation completed without a response body" },
          "400": { description: "Invalid request or unsupported preference" },
          "403": { description: "Policy, tenant or bulk capability denied" },
          "409": { description: "Idempotency key reused with a different request" },
          "429": { description: "Mutation row cap exceeded" },
          "503": { description: "Infrastructure failure" },
        },
      },
      patch: {
        summary: "Update policy-authorized rows",
        parameters: [
          { name: "table", in: "path", required: true, schema: { type: "string" } },
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Updated row representation" },
          "204": { description: "Mutation completed" },
        },
      },
      delete: {
        summary: "Delete policy-authorized rows",
        parameters: [
          { name: "table", in: "path", required: true, schema: { type: "string" } },
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Deleted row representation" },
          "204": { description: "Mutation completed" },
        },
      },
    },
    "/storage/v1/buckets": {
      get: {
        summary: "List policy-authorized Storage buckets",
        parameters: [
          ...tenantHeaders,
          { name: "search", in: "query", schema: { type: "string", maxLength: 63 } },
        ],
        responses: { "200": { description: "Bounded bucket list without provider metadata" } },
      },
      post: {
        summary: "Create a private Storage bucket",
        description:
          "Requires a current tenant-bound storage:admin capability, Storage policy authorization and Idempotency-Key. The privileged operation is audited.",
        parameters: [
          ...tenantHeaders,
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } },
        ],
        responses: {
          "201": { description: "Created bucket" },
          "403": { description: "Capability, tenant or Storage policy denied" },
          "409": { description: "Bucket exists with different settings" },
          "429": { description: "Bucket quota exceeded" },
        },
      },
    },
    "/storage/v1/buckets/{bucket}": {
      get: {
        summary: "Get one Storage bucket",
        parameters: [...tenantHeaders, storagePathParameters[0]],
        responses: { "200": { description: "Bucket settings" } },
      },
      patch: {
        summary: "Update supported bucket settings",
        description:
          "Currently only the isPublic metadata flag is supported. Public delivery is not exposed.",
        parameters: [
          ...tenantHeaders,
          storagePathParameters[0],
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Updated bucket" } },
      },
      delete: {
        summary: "Delete an empty bucket",
        parameters: [
          ...tenantHeaders,
          storagePathParameters[0],
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } },
        ],
        responses: {
          "204": { description: "Deleted or already absent" },
          "409": { description: "Metadata or provider objects remain" },
        },
      },
    },
    "/storage/v1/buckets/{bucket}/objects": {
      get: {
        summary: "List bounded object metadata",
        description:
          "Returns canonical logical paths only; provider keys and credentials are omitted.",
        parameters: [
          ...tenantHeaders,
          storagePathParameters[0],
          { name: "prefix", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "Up to 100 objects ordered by path" } },
      },
    },
    "/storage/v1/buckets/{bucket}/policy-summary": {
      get: {
        summary: "Read effective Storage permissions for the current actor",
        description:
          "Requires storage:admin and returns booleans only. Executable policy predicates and provider details are not exposed.",
        parameters: [...tenantHeaders, storagePathParameters[0]],
        responses: { "200": { description: "Effective bucket and object permissions" } },
      },
    },
    "/storage/v1/object/{bucket}/{path}": {
      put: {
        summary: "Upload one bounded object",
        description:
          "Raw-body upload with mandatory idempotency and declared MIME validation. Supported MIME types are application/octet-stream, UTF-8 text/plain, application/json, image/png, image/jpeg and application/pdf.",
        parameters: [
          ...tenantHeaders,
          ...storagePathParameters,
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } },
          {
            name: "X-Mekka-Content-SHA256",
            in: "header",
            schema: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        ],
        requestBody: { required: true, content: { "application/octet-stream": {} } },
        responses: {
          "201": { description: "Object metadata with ETag and SHA-256 headers" },
          "400": { description: "Invalid path, headers, checksum or MIME binding" },
          "403": { description: "Tenant or storage policy denied" },
          "409": { description: "Idempotency or object conflict" },
          "413": { description: "Configured object byte cap exceeded" },
        },
      },
      get: {
        summary: "Download one authenticated object",
        parameters: [
          ...tenantHeaders,
          ...storagePathParameters,
          { name: "If-None-Match", in: "header", schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Safe attachment response with private revalidation" },
          "304": { description: "ETag matched" },
          "404": { description: "Generic validation envelope for a missing object" },
        },
      },
      delete: {
        summary: "Delete one object idempotently",
        parameters: [
          ...tenantHeaders,
          ...storagePathParameters,
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } },
        ],
        responses: { "204": { description: "Deleted or already absent" } },
      },
    },
    "/storage/v1/object/sign/{bucket}/{path}": {
      post: {
        summary: "Issue a bounded read grant",
        description:
          "Accepts only {expiresIn} in integer seconds. The URL is built exclusively from the configured public storage origin and contains the complete tenant tuple.",
        parameters: [...tenantHeaders, ...storagePathParameters],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["expiresIn"],
                properties: { expiresIn: { type: "integer", minimum: 1 } },
              },
            },
          },
        },
        responses: {
          "200": { description: "Signed URL and millisecond expiresAt timestamp" },
          "400": { description: "Invalid JSON or expiry" },
          "403": { description: "Tenant or object read policy denied" },
        },
      },
    },
    "/storage/v1/signed/{bucket}/{path}": {
      get: {
        summary: "Redeem a signed object read grant without Bearer authentication",
        description:
          "Requires token, organizationId, projectId, environmentId, branchId and generation query parameters. Invalid, expired or incorrectly bound grants always return generic 403.",
        parameters: [
          ...storagePathParameters,
          ...[
            "token",
            "organizationId",
            "projectId",
            "environmentId",
            "branchId",
            "generation",
          ].map((name) => ({ name, in: "query", required: true, schema: { type: "string" } })),
        ],
        responses: {
          "200": { description: "Public immutable attachment response until grant expiry" },
          "304": { description: "ETag matched" },
          "403": { description: "Generic signed grant rejection" },
          "429": { description: "Signed redemption rate limit exceeded" },
        },
      },
    },
    "/storage/v1/resumable/{bucket}/{path}": {
      post: {
        summary: "Create a sequential resumable upload",
        description:
          "TUS-inspired subset requiring Tus-Resumable 1.0.0, fixed Upload-Length, Idempotency-Key and exactly one base64 contentType Upload-Metadata field. Only application/octet-stream is accepted.",
        parameters: [...tenantHeaders, ...storagePathParameters],
        responses: {
          "201": { description: "Upload Location, offset, length and expiry" },
          "400": { description: "Invalid or unsupported resumable metadata" },
          "413": { description: "Object byte cap exceeded" },
        },
      },
    },
    "/storage/v1/resumable/{uploadId}": {
      head: {
        summary: "Read resumable upload offset",
        parameters: [
          ...tenantHeaders,
          { name: "uploadId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Current offset, length and expiry" } },
      },
      patch: {
        summary: "Append one bounded sequential upload chunk",
        description:
          "Requires application/offset+octet-stream and the exact current Upload-Offset. No parallel or concatenated uploads are supported.",
        parameters: [
          ...tenantHeaders,
          { name: "uploadId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "204": {
            description: "Offset advanced; final response also includes object identity headers",
          },
          "409": { description: "Upload offset mismatch" },
          "413": { description: "Configured chunk byte cap exceeded" },
        },
      },
      delete: {
        summary: "Abort a resumable upload idempotently",
        parameters: [
          ...tenantHeaders,
          { name: "uploadId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "204": { description: "Aborted or already absent" } },
      },
    },
  },
});
