FROM quay.io/debezium/connect:3.4.3.Final

USER root
ADD --chmod=0644 https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/download/v2.28.1/opentelemetry-javaagent.jar /opt/opentelemetry-javaagent.jar
USER kafka

ENV ENABLE_OTEL=true
ENV JAVA_TOOL_OPTIONS="-javaagent:/opt/opentelemetry-javaagent.jar"
