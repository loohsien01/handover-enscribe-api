import { getSupabaseClient } from '../../utils/supabase.js';

const noteTemplatesTable = 'noteTemplates';

/**
 * Helper: Validates bigint ID format
 */
function isValidBigInt(id) {
  if (!id) return false;
  try {
    const parsed = BigInt(id);
    return parsed > 0n;
  } catch (error) {
    return false;
  }
}

/**
 * Gets all note templates for authenticated user (self-owned + system)
 * GET /api/note-templates
 */
export async function getAllNoteTemplates(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userId = user.id;

    const { data, error } = await supabase
      .from(noteTemplatesTable)
      .select('*')
      .or(`user_id.eq.${userId},user_id.is.null`)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Database error fetching note templates:', error);
      return reply.status(500).send({ error: 'Failed to fetch note templates' });
    }

    if (!data || data.length === 0) {
      return reply.status(200).send([]);
    }

    return reply.status(200).send(data);
  } catch (err) {
    console.error('Error fetching note templates:', err);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Gets a single note template by ID
 * GET /api/note-templates/:id
 */
export async function getNoteTemplate(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userId = user.id;
    const { id } = request.params;

    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid template ID format' });
    }

    const { data, error } = await supabase
      .from(noteTemplatesTable)
      .select('*')
      .eq('id', id)
      .or(`user_id.eq.${userId},user_id.is.null`)
      .single();

    if (error) {
      console.error('Database error fetching note template:', error);
      return reply.status(404).send({ error: 'Template not found' });
    }

    if (!data) {
      return reply.status(404).send({ error: 'Template not found' });
    }

    return reply.status(200).send(data);
  } catch (err) {
    console.error('Error fetching note template:', err);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Creates a new note template for the authenticated user
 * POST /api/note-templates
 */
export async function createNoteTemplate(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userId = user.id;
    const { name } = request.body;

    if (!name) {
      return reply.status(400).send({ error: 'Name is required' });
    }

    const template = {
      name,
      user_id: userId,
    };

    console.log('[createNoteTemplate] Creating template:', { name, user_id: userId });

    const { data: insertData, error: insertError } = await supabase
      .from(noteTemplatesTable)
      .insert([template])
      .select()
      .single();

    if (insertError) {
      console.error('Database error creating note template:', insertError);

      // Check for unique constraint violation (duplicate name for user)
      if (insertError.code === '23505') {
        return reply.status(409).send({
          code: 'DUPLICATE_NAME',
          message: 'A template with this name already exists for your account',
          field: 'name',
        });
      }

      return reply.status(400).send({ error: 'Failed to create template' });
    }

    return reply.status(201).send(insertData);
  } catch (err) {
    console.error('Error creating note template:', err);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Updates an existing note template
 * PATCH /api/note-templates/:id
 */
export async function updateNoteTemplate(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userId = user.id;
    const { id } = request.params;
    const updateData = request.body;

    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid template ID format' });
    }

    const { data: existingTemplate, error: fetchError } = await supabase
      .from(noteTemplatesTable)
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (fetchError || !existingTemplate) {
      console.error('Template not found or unauthorized:', fetchError);
      return reply.status(404).send({ error: 'Template not found' });
    }

    console.log('[updateNoteTemplate] Updating template:', { id, name: updateData.name });

    const { id: _, ...templateForUpdate } = updateData;

    const { data: updatedData, error: updateError } = await supabase
      .from(noteTemplatesTable)
      .update(templateForUpdate)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (updateError) {
      console.error('Database error updating note template:', updateError);

      if (updateError.code === '23505') {
        return reply.status(409).send({
          code: 'DUPLICATE_NAME',
          message: 'A template with this name already exists for your account',
          field: 'name',
        });
      }

      return reply.status(400).send({ error: 'Failed to update template' });
    }

    return reply.status(200).send(updatedData);
  } catch (err) {
    console.error('Error updating note template:', err);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Deletes a note template
 * DELETE /api/note-templates/:id
 */
export async function deleteNoteTemplate(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userId = user.id;
    const { id } = request.params;

    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid template ID format' });
    }

    const { error: deleteError } = await supabase
      .from(noteTemplatesTable)
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (deleteError) {
      console.error('Database error deleting note template:', deleteError);

      if (deleteError.code === '23503') {
        return reply.status(409).send({
          code: 'RESOURCE_IN_USE',
          message: 'This template is still being used. Remove all references first.',
        });
      }

      return reply.status(400).send({ error: 'Failed to delete template' });
    }

    return reply.status(204).send();
  } catch (err) {
    console.error('Error deleting note template:', err);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}
