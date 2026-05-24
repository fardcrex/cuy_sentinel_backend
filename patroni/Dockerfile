FROM postgres:15

RUN apt-get update && apt-get install -y \
    python3 python3-pip curl \
    && pip3 install patroni[etcd3] psycopg2-binary \
    && rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["patroni"]
CMD ["/etc/patroni/patroni.yml"]
