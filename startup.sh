#!/bin/bash
# Clean up node_modules and package-lock.json to force a fresh install
rm -rf /usr/src/app/node_modules /usr/src/app/package-lock.json /usr/src/app/static
# ... rest of startup.sh script
#!/bin/bash
set -e
# Start supervisord
if [ "$DOMAIN" = openfront.dev ] && [ "$SUBDOMAIN" != main ]; then
    exec timeout 18h /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
else
    exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
fi
