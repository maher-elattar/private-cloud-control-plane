# Kafka Connect with the Debezium PostgreSQL connector, built on the Strimzi distribution.
#
# WHY the Strimzi base rather than `quay.io/debezium/connect` (which the Compose stack uses):
# Strimzi's `KafkaConnect` resource manages the process — its configuration, its TLS material, its
# SCRAM identity, and its connectors — and it can only do that for an image laid out the way its
# own distribution is. Starting from `quay.io/strimzi/kafka` and adding one plugin directory keeps
# the connector identical while letting the operator own everything around it.
#
# WHY a Dockerfile rather than `KafkaConnect.spec.build`: an in-cluster build has to push the
# result somewhere, and standing up a container registry to hold one image is more moving parts
# than the image itself. The plugin coordinates and digests below are the same declarative record
# a build specification would hold.
#
# The Debezium version is deliberately newer than the Compose stack's 3.4.3.Final: Strimzi 1.2.0
# ships Kafka 4.2 and 4.3 only, and 3.6.2.Final is the current release built against Kafka 4.x.
# The connector configuration is unchanged between the two, and `deploy/kubernetes/data/kafka-connect.yaml`
# holds the same Event Router settings as `deploy/local/debezium/outbox-connector.json`.
FROM quay.io/strimzi/kafka:1.2.0-kafka-4.3.1

USER root

ADD --chmod=0644 --checksum=sha256:3a48d716eccd460670ca9885557c6ec9eedce91d715f86714f29f9ebe75a5f71 \
  https://repo1.maven.org/maven2/io/debezium/debezium-connector-postgres/3.6.2.Final/debezium-connector-postgres-3.6.2.Final-plugin.tar.gz \
  /tmp/debezium-connector-postgres.tar.gz

# The interceptor restores the Event Router's trace context before the record is produced, so a
# span from the accepting HTTP request continues into the Kafka record the consumer receives.
ADD --chmod=0644 --checksum=sha256:407cef68ab8e676a2868018cc2e6f0d33c90dda4a03983e2b4eedd3f9a7c1fe6 \
  https://repo1.maven.org/maven2/io/debezium/debezium-interceptor/3.6.2.Final/debezium-interceptor-3.6.2.Final.jar \
  /opt/kafka/libs/debezium-interceptor.jar

RUN mkdir -p /opt/kafka/plugins/debezium-postgres \
  && tar -xzf /tmp/debezium-connector-postgres.tar.gz \
    -C /opt/kafka/plugins/debezium-postgres --strip-components=1 \
  && rm /tmp/debezium-connector-postgres.tar.gz \
  && chown -R 1001:0 /opt/kafka/plugins /opt/kafka/libs/debezium-interceptor.jar \
  && chmod -R g+rwX /opt/kafka/plugins

USER 1001
