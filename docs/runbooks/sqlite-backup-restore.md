# SQLite Backup And Restore Runbook

## Scope
This runbook applies to the local `StorageAdapter` implementation. It uses SQLite `VACUUM INTO` through `StorageAdapter.createCheckpoint`; never copy an active `.sqlite`, `-wal`, or `-shm` file.

## Create Checkpoint
1. Resolve the approved database and checkpoint directories through the control-plane routing tuple.
2. Call `createCheckpoint(storage, { id, checkpointPath, checkpointDirectory })`.
3. Persist the returned backup artifact with tenant routing metadata outside the database.
4. Verify that checkpoint storage is durable and encrypted before allowing destructive work.

## Restore Drill
1. Restore only into a new, empty path in an approved directory with `restoreCheckpoint`.
2. The engine opens the checkpoint, runs `pragma_integrity_check`, verifies the schema fingerprint, then creates the new database using `VACUUM INTO`.
3. It reopens the restored database and repeats integrity and schema-fingerprint verification. The fingerprint intentionally excludes SQLite's local `schema_version`, which can differ after reconstruction.
4. Run tenant-specific data smoke checks before routing traffic to the restored database.

## Incident Rules
- Do not overwrite a live database in place.
- Do not use filesystem copy as a backup or restore primitive.
- If integrity or schema hash verification fails, keep the target isolated, preserve evidence, and open an incident.
- Record actor, checkpoint identifier, source/destination routing tuple, restore approval, and verification outcome in the audit system.
