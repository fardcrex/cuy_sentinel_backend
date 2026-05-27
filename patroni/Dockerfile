FROM postgres:15

RUN apt-get update && apt-get install -y \
    python3 python3-pip curl \
    && pip3 install --break-system-packages patroni[etcd3] psycopg2-binary \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data/patroni \
    && chown -R postgres:postgres /data \
    && chmod 700 /data/patroni

USER postgres
ENTRYPOINT ["patroni"]
CMD ["/etc/patroni/patroni.yml"]
