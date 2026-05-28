{{/*
Expand the name of the chart.
*/}}
{{- define "gatewaze-monitoring.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified resource name. Pattern:
  <release>-<chart>
unless `fullnameOverride` is set.
*/}}
{{- define "gatewaze-monitoring.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Common labels stamped on every resource.
*/}}
{{- define "gatewaze-monitoring.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "gatewaze-monitoring.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: gatewaze
{{- end }}

{{/*
Selector labels for the Gatewaze pods we monitor. Mirrors the labels the
core gatewaze chart's `gatewaze.selectorLabels` produces.
*/}}
{{- define "gatewaze-monitoring.gatewazeSelectorLabels" -}}
app.kubernetes.io/name: {{ .Values.gatewaze.instanceName }}
app.kubernetes.io/instance: {{ .Values.gatewaze.instanceName }}
{{- end }}
