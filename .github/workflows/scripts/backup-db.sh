#!/bin/bash
# Backup script untuk Railway + Supabase
# Usage: bash scripts/backup-db.sh

set -e

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="backup_izyanalisai_${DATE}.sql"
BACKUP_DIR="/tmp"

echo "Starting backup: ${BACKUP_FILE}"

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
    echo "ERROR: DATABASE_URL not set"
    exit 1
fi

# Run pg_dump
pg_dump "$DATABASE_URL" \
    --clean \
    --if-exists \
    --no-owner \
    --no-privileges \
    --exclude-table-data=audit_logs \
    > "${BACKUP_DIR}/${BACKUP_FILE}"

echo "Backup completed: ${BACKUP_DIR}/${BACKUP_FILE}"
echo "Size: $(ls -lh ${BACKUP_DIR}/${BACKUP_FILE} | awk '{print $5}')"
