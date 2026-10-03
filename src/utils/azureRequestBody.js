/**
 * Azure OpenAI SOAP Note Request Body Generator
 * 
 * Generates request bodies optimized for Azure OpenAI API.
 * Uses gpt-4o model via Azure deployment (o3 not yet available on Azure).
 */

const SchemaType = {
    OBJECT: "object",
    STRING: "string"
};

/**
 * Generates Azure OpenAI request body for SOAP note and billing generation.
 * Optimized for Azure OpenAI (uses gpt-4o, not o3).
 * 
 * @param {string} transcript - The masked medical transcript
 * @returns {object} Azure OpenAI request body for SOAP note generation
 */
export function getSoapNoteAndBillingRequestBody(transcript) {
    return {
        messages: [
            {
                role: "system",
                content: "You are a clinical documentation assistant trained to generate SOAP notes from detailed patient encounters. Your output must be accurate and avoid omitting important clinical details. But only output data if present in the transcript, otherwise leave it blank. '•' is invalid symbol never use it.",
                cache_control: { type: "ephemeral" }
            },
            {
                role: "user",
                content: `Here is a patient encounter transcript:\n\n${transcript}\n\nGenerate SOAP note and billing suggestions. PHI information has been masked for privacy. Example (for reference only): Jane is 105 years old --> {{NAME_1}} is {{AGE_2}} years old.
                Use bullet points (marked by '-' symbols, '•' is invalid symbol) and markdown formatting and "\\n"for clarity.`
            }
        ],
        max_completion_tokens: 10000,
        temperature: 1.0,
        top_p: 1.0,
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "soap_and_billing",
                schema: {
                    type: SchemaType.OBJECT,
                    properties: {
                        soap_note: {
                            type: SchemaType.OBJECT,
                            properties: {
                                subjective: {
                                    type: SchemaType.OBJECT,
                                    description: "Subjective findings - what the patient reports (symptoms, concerns, history)",
                                    properties: {
                                        "Chief complaint": { type: SchemaType.STRING, description: "Chief complaint of the patient" },
                                        HPI: { type: SchemaType.STRING, description: "History of Present Illnesses. " },
                                        History: { type: SchemaType.STRING, description: "Past medical, surgical, family, and social history" },
                                        ROS: { type: SchemaType.STRING, description: "Review of Systems" },
                                        Medications: { type: SchemaType.STRING, description: "Current medications" },
                                        Allergies: { type: SchemaType.STRING, description: "Known allergies" }
                                    },
                                    required: ["Chief complaint", "HPI", "History", "ROS", "Medications", "Allergies"],
                                    propertyOrdering: ["Chief complaint", "HPI", "History", "ROS", "Medications", "Allergies"],
                                },
                                objective: {
                                    type: SchemaType.OBJECT,
                                    description: "Objective clinical observations - measurable/observable findings (vitals, physical exam, lab results). If not mentioned in transcript, assume result is normal/as expected.",
                                    properties: {
                                        HEENT: { type: SchemaType.STRING, description: "HEENT (Head, Eyes, Ears, Nose, Throat) exam findings" },
                                        General: { type: SchemaType.STRING, description: "General exam findings" },
                                        Cardiovascular: { type: SchemaType.STRING, description: "Cardiovascular exam findings" },
                                        Musculoskeletal: { type: SchemaType.STRING, description: "Musculoskeletal exam findings" },
                                        Other: { type: SchemaType.STRING, description: "Other objective findings" }
                                    },
                                    required: ["HEENT", "General", "Cardiovascular", "Musculoskeletal", "Other"],
                                    propertyOrdering: ["HEENT", "General", "Cardiovascular", "Musculoskeletal", "Other"]
                                },
                                assessment: { type: SchemaType.STRING, description: "Clinical assessment and diagnosis based on subjective and objective findings" },
                                plan: { type: SchemaType.STRING, description: "Based solely on the transcript, summarize a treatment plan, medications, follow-up instructions and next steps. Do not include your own assumptions or inferences, and only output data if present in the transcript, otherwise leave it blank." }
                            },
                            required: ["subjective", "objective", "assessment", "plan"]
                        },
                        billing: {
                            type: SchemaType.OBJECT,
                            properties: {
                                icd10_codes: {
                                    type: "array",
                                    items: { type: SchemaType.STRING, description: "ICD-10 code followed by a brief description" },
                                    description: "ICD-10 codes for the diagnosis. Max 4, can have additional supporting codes"
                                },
                                billing_code: { type: SchemaType.STRING, description: "CPT codes for the services provided, with justification. Billing code for new (99202–99205) / established (99211–99215) patient." },
                                additional_inquiries: { type: SchemaType.STRING, description: "Doctor's additional areas of investigation for the patient to increase doctor's billing level" }
                            },
                            required: ["icd10_codes", "billing_code", "additional_inquiries"]
                        }
                    },
                    required: ["soap_note", "billing"],
                    additionalProperties: false
                }
            }
        }
    };
}
