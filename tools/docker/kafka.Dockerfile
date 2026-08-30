FROM apache/kafka:4.1.2

USER root
ADD --chmod=0644 --checksum=sha256:a95983fd96e865d2bcdf911cc500e7c82808c27ab9fd226bf96732b6c3d8c46e https://github.com/prometheus/jmx_exporter/releases/download/1.6.0/jmx_prometheus_javaagent-1.6.0.jar /opt/jmx-exporter/jmx_prometheus_javaagent.jar
COPY deploy/local/observability/jmx/kafka.yaml /opt/jmx-exporter/kafka.yaml
RUN chmod 0755 /opt/jmx-exporter \
  && chown -R appuser:appuser /opt/jmx-exporter
USER appuser

ENV KAFKA_OPTS="-javaagent:/opt/jmx-exporter/jmx_prometheus_javaagent.jar=/opt/jmx-exporter/kafka.yaml"
