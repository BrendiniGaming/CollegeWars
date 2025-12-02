#!/bin/bash
set -e

# CRITICAL STEP: CLEANUP CORRUPTED DATA & CACHE ON SERVER START
# This removes the conflicting node_modules, lock file, and built client files
# The "npm install" in the Dockerfile will rebuild this cleanly.
rm -rf /usr/src/app/node_modules /usr/src/app/package-lock.json /usr/src/app/static

# Original server startup logic
if [ "$DOMAIN" = openfront.dev ] && [ "$SUBDOMAIN" != main ]; then
    exec timeout 18h /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
else
    exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
fi
