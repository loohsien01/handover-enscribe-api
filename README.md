# Enscribe API

A comprehensive healthcare management platform built with [Next.js](https://nextjs.org) for managing patient encounters, SOAP notes, recordings, and transcripts with advanced AI-powered features.

## Overview

Enscribe API is a full-stack telemedicine application designed for healthcare providers to efficiently manage patient interactions, generate clinical documentation, and transcribe medical recordings. The platform integrates with Google Cloud Platform (GCP) and AWS services for transcription, AI processing, and data masking.

## Features

- **Patient Encounter Management** - Create, view, and edit patient encounters
- **SOAP Notes** - Generate and manage SOAP (Subjective, Objective, Assessment, Plan) notes
- **Audio Recording & Transcription** - Record, upload, and transcribe patient interactions
- **AI-Powered Processing** - Integration with Google Gemini and OpenAI for note generation
- **Dot Phrases** - Custom medical phrase templates for quick documentation
- **PHI Masking** - AWS-powered Protected Health Information masking
- **Authentication** - Secure user authentication with email verification
- **Data Privacy** - Row-level security policies in the database
- **Mobile Support** - React Native mobile application

## Project Structure

```
enscribe-api/
├── src/
│   ├── app/              # Next.js App Router pages and layouts
│   ├── components/       # React components
│   ├── hooks/           # Custom React hooks
│   ├── pages/api/       # API routes and endpoints
│   └── utils/           # Utility functions and helpers
├── mobile/              # React Native mobile app
├── public/              # Static assets and client-side scripts
├── sql/                 # Database schemas and triggers
└── keys/                # SSH keys (for deployment)
```

## Getting Started

### Prerequisites

- Node.js 16+ and npm/yarn
- Supabase account for database
- Google Cloud Platform credentials (for transcription)
- AWS credentials (for PHI masking)
- OpenAI API key (optional)

### Installation

```bash
# Install dependencies
npm install
```

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Build for Production

```bash
npm run build
npm start
```

## API Endpoints

Key API routes available in `/src/pages/api/`:

- `auth.js` - Authentication endpoints
- `patient-encounters.js` - Patient encounter CRUD operations
- `soap-notes.js` - SOAP note management
- `recordings.js` - Recording upload/download
- `transcripts.js` - Transcript management
- `dot-phrases.js` - Dot phrase operations
- `gcp/transcribe.js` - Deepgram transcription service
- `aws/mask-phi.js` - AWS PHI masking service

## Database

The application uses Supabase (PostgreSQL) with:
- Row-Level Security (RLS) policies
- Automated triggers for timestamp updates
- Foreign key constraints and referential integrity

See `/sql/` for database schema and policies.

## Environment Variables

Create a `.env.local` file with:

```
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
# Optional: Bearer secret for POST /api/internal/cleanup/run (GitHub Actions cron)
INTERNAL_CLEANUP_SECRET=
GOOGLE_CLOUD_PROJECT_ID=
GOOGLE_CLOUD_PRIVATE_KEY=
GOOGLE_CLOUD_CLIENT_EMAIL=
# Deepgram API Configuration
# Required for audio transcription via Deepgram Nova-3 model
DEEPGRAM_API_KEY=
# AWS Comprehend Medical Configuration
# Required for LOCAL development only to test maskPhiHelper
# Not needed on EC2 - the EC2 instance IAM role provides access automatically
AWS_COMPREHEND_ACCESS_KEY_ID=
AWS_COMPREHEND_SECRET_ACCESS_KEY=
OPENAI_API_KEY=
```

## Architecture Migration: Next.js → Fastify Backend

### Current State (Hybrid)
- **Frontend**: Next.js (`npm run dev` on port 3000)
- **Backend**: Fastify (`npm run dev:fastify` on port 3001)
- Both run simultaneously; Next.js proxies `/api/*` to Fastify

```bash
# Terminal 1: Backend
npm run dev:fastify

# Terminal 2: Frontend
npm run dev
```

### Final State (Fastify-Only Backend)
When migration completes, this repo becomes **pure backend API only**:

```
src/
├── controllers/              # (was src/fastify/controllers/)
│   ├── authController.js
│   ├── patientEncountersController.js
│   ├── dotPhrasesController.js
│   ├── recordingsController.js
│   ├── soapNotesController.js
│   └── transcriptsController.js
├── routes/                   # (was src/fastify/routes/)
│   ├── auth.js
│   ├── patientEncounters.js
│   ├── dotPhrases.js
│   ├── recordings.js
│   ├── soapNotes.js
│   └── transcripts.js
├── schemas/                  # (was src/fastify/schemas/)
│   ├── patientEncounter.js
│   ├── soapNote.js
│   ├── recording.js
│   ├── transcript.js
│   ├── dotPhrase.js
│   └── regex.js
├── plugins/
│   └── authentication.js     # Fastify auth decorator
├── server.js                 # Main entry point
└── utils/                    # Shared utilities (supabase, encryption, etc)
```

**Run command after flattening:**
```bash
npm run dev  # Runs src/server.js on port 3001
```

**Frontend moves to separate repo:**
- All `src/app/`, `src/components/`, `public/` → `enscribe-frontend/`
- Next.js remains lightweight frontend, proxies to this backend

## Learn More

- [Fastify Documentation](https://www.fastify.io/docs/latest/)
- [Supabase Documentation](https://supabase.com/docs)
- [Google Cloud Speech-to-Text](https://cloud.google.com/speech-to-text/docs)
- [AWS Comprehend Medical](https://aws.amazon.com/comprehend/medical/)
