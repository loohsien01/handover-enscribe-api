/**
 * Claude Bedrock SOAP Note Request Body Generator
 * 
 * Generates request bodies optimized for Claude via AWS Bedrock.
 * Claude doesn't support response_format parameter, so JSON schema 
 * requirements are embedded directly in the system message.
 */

const SchemaType = {
    OBJECT: "object",
    STRING: "string"
};

/**
 * Helper: Escape special characters in template section fields for safe JSON embedding
 * Handles quotes, newlines, backslashes, and other JSON escape sequences
 * Also replaces backticks to prevent template literal breakage
 * @param {string} str - The string to escape
 * @returns {string} - The escaped string safe for JSON
 */
function escapeJsonString(str) {
    if (!str) return '';
    return String(str)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
        .replace(/`/g, "'");
}

/**
 * Generates Claude Bedrock request body for SOAP note and billing generation.
 * Uses claude-sonnet-4-6 model via AWS Bedrock.
 * 
 * Note: Claude doesn't support response_format parameter like OpenAI,
 * so the JSON schema is specified in the system prompt and we trust
 * Claude to follow the format requirements.
 * 
 * @param {string} transcript - The masked medical transcript
 * @param {Array} noteTemplateSections - Optional note template sections with { name, layout, details }
 * @returns {object} Claude Bedrock request body for SOAP note generation
 */
export function getSoapNoteAndBillingRequestBody(transcript, noteTemplateSections = null) {
    // Build JSON schema based on whether we have a note template
    let jsonSchemaDescription;
    
    if (noteTemplateSections && Array.isArray(noteTemplateSections) && noteTemplateSections.length > 0) {
        // Dynamically build schema from template sections
        // Escape all template fields to prevent JSON injection
        const sections = noteTemplateSections.map(s => `  "${escapeJsonString(s.name)}": "${escapeJsonString(s.layout)} - ${escapeJsonString(s.details)}"`).join(',\n');
        jsonSchemaDescription = `
You MUST return a valid JSON object with this exact structure based on the template:
{
${sections}
}`;
    } else {
        // Fallback to original schema
        jsonSchemaDescription = `
You MUST return a valid JSON object with this exact structure:
{
  "soap_note": {
    "subjective": {
      "Chief complaint": "string - Chief complaint of the patient",
      "HPI": "string - History of Present Illnesses",
      "History": "string - Past medical, surgical, family, and social history",
      "ROS": "string - Review of Systems",
      "Medications": "string - Current medications",
      "Allergies": "string - Known allergies"
    },
    "objective": {
      "HEENT": "string - HEENT (Head, Eyes, Ears, Nose, Throat) exam findings. If not mentioned, assume normal.",
      "General": "string - General exam findings",
      "Cardiovascular": "string - Cardiovascular exam findings",
      "Musculoskeletal": "string - Musculoskeletal exam findings",
      "Other": "string - Other objective findings (vitals, physical exam, lab results)"
    },
    "assessment": "string - Clinical assessment and diagnosis based on subjective and objective findings",
    "plan": "string - Treatment plan, medications, follow-up instructions and next steps. Base solely on transcript - do not include assumptions. Only output data if present in transcript."
  },
  "billing": {
    "icd10_codes": "array of strings - ICD-10 codes with description (format: 'CODE - Description'). Max 4, can have additional supporting codes. Example: 'M79.3 - Panniculitis, unspecified'",
    "billing_code": "string - CPT codes for services provided. Use 99202–99205 for new patients / 99211–99215 for established patients with justification",
    "additional_inquiries": "string - Doctor's additional areas of investigation for the patient to increase doctor's billing level"
  }
}`;
    }

    return {
        // modelId: "us.anthropic.claude-sonnet-4-6",
        modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        system: [
            {
                type: "text",
                text: "You are a clinical documentation assistant trained to generate SOAP notes from detailed patient encounters. Your output must be accurate and avoid omitting important clinical details. Only output data if present in the transcript, otherwise leave it blank. Never use '•' symbol - use '-' for bullet points instead.",
                cache_control: { type: "ephemeral" }
            },
            {
                type: "text",
                text: jsonSchemaDescription,
                cache_control: { type: "ephemeral" }
            }
        ],
        messages: [
            {
                role: "user",
                content: `Here is a patient encounter transcript:

${transcript}

Generate SOAP note and billing suggestions. PHI information has been masked for privacy. Example (for reference only): Evan is 105 years old --> {{NAME_1}} is {{AGE_2}} years old.
Use bullet points (marked by '-' symbols, '•' is invalid symbol) and markdown formatting and "\\n" for clarity.

IMPORTANT: Return ONLY valid JSON matching the structure above. Do not include any text before or after the JSON.`
            }
        ],
        max_tokens: 10000,
    };
}
