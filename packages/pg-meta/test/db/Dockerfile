FROM supabase/postgres:14.1.0

RUN openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
  -keyout /var/lib/postgresql/server.key -out /var/lib/postgresql/server.crt \
  && chown postgres:postgres /var/lib/postgresql/server.key /var/lib/postgresql/server.crt \
  && chmod 600 /var/lib/postgresql/server.key /var/lib/postgresql/server.crt
