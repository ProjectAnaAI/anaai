# AnaAI Collaborator Handoff

## Purpose

This document provides the engineering handoff for AnaAI.

AnaAI is a multi-tenant AI receptionist platform for service businesses. The system combines business configuration, customer/service management, appointments, AI receptionist settings, business knowledge, analytics, and Twilio-based voice reception.

## Current Architecture

Tenant access follows this invariant:

```text
authenticated user
→ business_members
→ active business selection
→ business-scoped query/mutation
→ database or server-side membership validation