# Product

<!-- impeccable:product-schema 1 -->

## Platform

desktop (Tauri with a React webview)

## Users

Individual professionals who repeatedly process PDFs locally on their desktop,
including documents whose contents should not be sent to an external service.

## Product Purpose

PDF Manager provides focused local workflows for inspecting, transforming, and
editing PDF documents. Success means completing routine document work clearly
and reliably while preserving the user's source files.

## Positioning

The product combines independent, task-specific PDF tools in one local desktop
application instead of routing document contents through a hosted service.

## Operating Context

Users work with files from their computer in a Tauri desktop shell backed by a
local React and FastAPI application. The document or preview is the primary
workspace; controls support repetitive work without obscuring it.

## Capabilities and Constraints

- Feature workflows own their state and output independently.
- Source documents are preserved unless a feature contract explicitly states
  otherwise.
- Edit Canvas and Edit Content are separate tools with separate engines,
  histories, and save behavior.
- Edit Content V1 is limited to guarded edits of supported native PDF text
  objects; unsupported or uncertain content fails safely.

## Evidence on Hand

The repository contains the running product, automated tests, and the current
OpenSpec artifacts. Private validation documents and internal project records
remain under their existing ignored locations and must not be exposed.

## Product Principles

- Keep document processing local.
- Preserve source files and fail safely when integrity cannot be proven.
- Prefer focused, independent workflows over a unified editor with shared
  mutable state.
- Keep the document central and operational controls compact.
