FROM quay.io/debezium/connect:3.4.3.Final

USER root
ADD --chmod=0644 --checksum=sha256:faa89bdeebf9b1f52be4a4374689176717b02a59df2d8f8b6eb9aa39f9292589 https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/download/v2.28.1/opentelemetry-javaagent.jar /opt/opentelemetry-javaagent.jar
ADD --chmod=0644 --checksum=sha256:be2fc296cfab5652ed4b150480b2b8778a24fa0d82c56bdff6767ec1a89e448c https://repo1.maven.org/maven2/io/debezium/debezium-interceptor/3.4.3.Final/debezium-interceptor-3.4.3.Final.jar /kafka/libs/debezium-interceptor.jar
ADD --chmod=0644 --checksum=sha256:a95983fd96e865d2bcdf911cc500e7c82808c27ab9fd226bf96732b6c3d8c46e https://github.com/prometheus/jmx_exporter/releases/download/1.6.0/jmx_prometheus_javaagent-1.6.0.jar /opt/jmx-exporter/jmx_prometheus_javaagent.jar
COPY deploy/local/observability/jmx/connect.yaml /opt/jmx-exporter/connect.yaml
RUN for jar in /kafka/external_libs/otel/*.jar; do ln -s "$jar" "/kafka/libs/$(basename "$jar")"; done \
    && chmod 0755 /opt/jmx-exporter
USER kafka

ENV ENABLE_OTEL=true
ENV JAVA_TOOL_OPTIONS="-javaagent:/opt/opentelemetry-javaagent.jar -javaagent:/opt/jmx-exporter/jmx_prometheus_javaagent.jar=/opt/jmx-exporter/connect.yaml"
