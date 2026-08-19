FROM ghcr.io/tursodatabase/libsql-server@sha256:81b48cb383cc52e5cedb44d8c5c6b94556062384439bba685ddfaffcf3bcc0be

USER root
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*
