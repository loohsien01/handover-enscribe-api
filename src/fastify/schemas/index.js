/**
 * Fastify-compatible schema exports
 * All schemas use relative imports instead of @/src alias
 * Database schemas are exported singular (singular noun convention)
 */

export { dotPhraseSchema } from './dotPhrase.js';
export { patientEncounterSchema } from './patientEncounter.js';
export { recordingSchema } from './recording.js';
export { soapNoteSchema } from './soapNote.js';
export { transcriptSchema } from './transcript.js';
export { notesCreateSchema } from './note.js';
export { noteTemplateDatabaseSchema } from './noteTemplate.js';
export { noteTemplateSectionDatabaseSchema } from './noteTemplateSection.js';
export { noteTemplateSectionOrderDatabaseSchema } from './noteTemplateSectionOrder.js';
export { userSecurityConfigDatabaseSchema } from './userSecurityConfig.js';
export { userProfileDatabaseSchema } from './userProfile.js';
export { uuidRegex, isoDatetimeRegex } from './regex.js';
