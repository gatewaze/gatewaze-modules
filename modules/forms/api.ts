/**
 * API routes for the forms module.
 *
 * Public endpoints for fetching form definitions and submitting responses.
 * Submissions automatically create/link people records by email.
 */

import type { Express, Request, Response } from 'express';
import type { ModuleContext } from '@gatewaze/shared';
import { createRequire } from 'module';
import { join } from 'path';

let _supabase: any = null;

function initSupabase(projectRoot: string) {
  if (_supabase) return _supabase;

  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');

  // Resolve @supabase/supabase-js from the API package's node_modules
  const require = createRequire(join(projectRoot, 'packages', 'api', 'package.json'));
  const { createClient } = require('@supabase/supabase-js');
  _supabase = createClient(url, key);
  return _supabase;
}

function cors(_req: Request, res: Response) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  return res.sendStatus(204);
}

export function registerRoutes(app: Express, context?: ModuleContext) {
  const projectRoot = context?.projectRoot || process.cwd();

  // -----------------------------------------------------------------------
  // CORS — allow all origins for all forms endpoints (embeds, external sites)
  // -----------------------------------------------------------------------
  app.options('/api/modules/forms/:slug', cors);
  app.options('/api/modules/forms/:slug/submit', cors);
  app.options('/api/modules/forms/:slug/embed.js', cors);
  app.use('/api/modules/forms', (_req: Request, res: Response, next: Function) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  // -----------------------------------------------------------------------
  // GET /api/modules/forms/:slug — fetch form definition (public)
  // -----------------------------------------------------------------------
  app.get('/api/modules/forms/:slug', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { data, error } = await supabase
        .from('forms')
        .select('id, slug, name, description, fields, thank_you_message, settings')
        .eq('slug', req.params.slug)
        .eq('is_active', true)
        .single();

      if (error || !data) {
        return res.status(404).json({ error: 'Form not found' });
      }

      return res.json(data);
    } catch (err: any) {
      console.error('[forms] Error fetching form:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/modules/forms/:slug/submit — submit form (public)
  // -----------------------------------------------------------------------
  app.post('/api/modules/forms/:slug/submit', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);

      // 1. Fetch the form
      const { data: form, error: formError } = await supabase
        .from('forms')
        .select('*')
        .eq('slug', req.params.slug)
        .eq('is_active', true)
        .single();

      if (formError || !form) {
        return res.status(404).json({ error: 'Form not found' });
      }

      const { responses } = req.body;
      if (!responses || typeof responses !== 'object') {
        return res.status(400).json({ error: 'Missing responses object' });
      }

      // 2. Extract email from responses (look for email-type field)
      const fields = (form.fields || []) as Array<{ id: string; type: string; label: string }>;
      const emailField = fields.find(f => f.type === 'email');
      const email = emailField ? responses[emailField.id] : null;

      let personId: string | null = null;

      if (email && typeof email === 'string' && email.includes('@')) {
        const normalizedEmail = email.toLowerCase().trim();

        // Build user_metadata from form field responses
        const userMetadata: Record<string, any> = {};
        for (const field of fields) {
          if (field.type === 'email') continue;
          const value = responses[field.id];
          if (value !== undefined && value !== null && value !== '') {
            userMetadata[field.id] = value;
          }
        }

        // 3. Create/find person + auth user via people-signup edge function
        const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
        const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        try {
          // Forward client IP so people-signup can geolocate
          const clientIp = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()
            || req.headers['x-real-ip']?.toString()
            || req.ip
            || '';

          const signupRes = await fetch(`${supabaseUrl}/functions/v1/people-signup`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${serviceRoleKey}`,
              'apikey': serviceRoleKey!,
              ...(clientIp ? { 'x-forwarded-for': clientIp } : {}),
            },
            body: JSON.stringify({
              email: normalizedEmail,
              source: `form_submission:${form.slug}`,
              user_metadata: userMetadata,
            }),
          });

          const signupData = await signupRes.json();

          if (signupData.person_id) {
            personId = signupData.person_id;
          } else {
            console.error('[forms] people-signup did not return person_id:', signupData);
            // Fallback: look up person directly
            const { data: person } = await supabase
              .from('people')
              .select('id')
              .eq('email', normalizedEmail)
              .maybeSingle();
            personId = person?.id || null;
          }
        } catch (signupErr) {
          console.error('[forms] Error calling people-signup:', signupErr);
          // Fallback: look up or create person directly
          const { data: person } = await supabase
            .from('people')
            .select('id')
            .eq('email', normalizedEmail)
            .maybeSingle();
          personId = person?.id || null;
        }
      }

      // 4. Save submission
      const metadata: Record<string, string | null> = {
        user_agent: req.headers['user-agent'] || null,
        referrer: req.headers['referer'] || null,
        source: req.body.source || 'direct',
      };

      const { data: submission, error: subError } = await supabase
        .from('forms_submissions')
        .insert({
          form_id: form.id,
          person_id: personId,
          responses,
          metadata,
        })
        .select('id')
        .single();

      if (subError) {
        console.error('[forms] Error saving submission:', subError);
        return res.status(500).json({ error: 'Failed to save submission' });
      }

      return res.json({
        success: true,
        submission_id: submission?.id,
        thank_you_message: form.thank_you_message,
      });
    } catch (err: any) {
      console.error('[forms] Error processing submission:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/modules/forms/:slug/embed.js — embeddable form script
  // -----------------------------------------------------------------------
  app.get('/api/modules/forms/:slug/embed.js', async (req: Request, res: Response) => {
    const slug = req.params.slug;

    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');

    const script = `
(function() {
  var FORM_SLUG = ${JSON.stringify(slug)};

  // Derive API base from the script's own src URL (preserves the public hostname)
  var scriptEl = document.querySelector('script[data-gatewaze-form="' + FORM_SLUG + '"]')
    || document.querySelector('script[src*="' + FORM_SLUG + '/embed.js"]');
  if (!scriptEl) return;
  var srcUrl = scriptEl.src;
  var API_BASE = srcUrl.substring(0, srcUrl.indexOf('/api/'));

  // Find the script tag that loaded this script
  var scripts = [scriptEl];

  var scriptTag = scripts[scripts.length - 1];
  var container = document.createElement('div');
  container.className = 'gatewaze-form-container';
  container.setAttribute('data-form-slug', FORM_SLUG);
  scriptTag.parentNode.insertBefore(container, scriptTag.nextSibling);

  // Inject minimal styles
  if (!document.getElementById('gatewaze-form-styles')) {
    var style = document.createElement('style');
    style.id = 'gatewaze-form-styles';
    style.textContent = [
      '.gatewaze-form-container { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 600px; }',
      '.gatewaze-form-container * { box-sizing: border-box; }',
      '.gatewaze-form-container form { display: flex; flex-direction: column; gap: 16px; }',
      '.gatewaze-form-container .gw-field { display: flex; flex-direction: column; gap: 4px; }',
      '.gatewaze-form-container label { font-size: 14px; font-weight: 500; color: #374151; }',
      '.gatewaze-form-container .gw-required { color: #ef4444; margin-left: 2px; }',
      '.gatewaze-form-container input, .gatewaze-form-container textarea, .gatewaze-form-container select { width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; line-height: 1.5; color: #111827; background: #fff; transition: border-color 0.15s; }',
      '.gatewaze-form-container input:focus, .gatewaze-form-container textarea:focus, .gatewaze-form-container select:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1); }',
      '.gatewaze-form-container textarea { min-height: 80px; resize: vertical; }',
      '.gatewaze-form-container .gw-checkbox-group, .gatewaze-form-container .gw-radio-group { display: flex; flex-direction: column; gap: 8px; }',
      '.gatewaze-form-container .gw-checkbox-item, .gatewaze-form-container .gw-radio-item { display: flex; align-items: center; gap: 8px; font-size: 14px; color: #374151; cursor: pointer; }',
      '.gatewaze-form-container .gw-checkbox-item input, .gatewaze-form-container .gw-radio-item input { width: auto; margin: 0; }',
      '.gatewaze-form-container button[type="submit"] { padding: 10px 20px; background: #6366f1; color: #fff; border: none; border-radius: 6px; font-size: 14px; font-weight: 500; cursor: pointer; transition: background 0.15s; }',
      '.gatewaze-form-container button[type="submit"]:hover { background: #4f46e5; }',
      '.gatewaze-form-container button[type="submit"]:disabled { background: #9ca3af; cursor: not-allowed; }',
      '.gatewaze-form-container .gw-thank-you { padding: 24px; text-align: center; color: #374151; }',
      '.gatewaze-form-container .gw-thank-you h3 { font-size: 18px; font-weight: 600; margin: 0 0 8px 0; color: #111827; }',
      '.gatewaze-form-container .gw-error { color: #ef4444; font-size: 12px; margin-top: 2px; }',
      '.gatewaze-form-container .gw-description { color: #6b7280; font-size: 14px; margin: 0 0 16px 0; }',
    ].join('\\n');
    document.head.appendChild(style);
  }

  // Fetch form and render
  fetch(API_BASE + '/api/modules/forms/' + FORM_SLUG)
    .then(function(r) { return r.json(); })
    .then(function(form) {
      if (!form || !form.fields) {
        container.innerHTML = '<p style="color:#ef4444;">Form not found.</p>';
        return;
      }
      renderForm(container, form);
    })
    .catch(function() {
      container.innerHTML = '<p style="color:#ef4444;">Failed to load form.</p>';
    });

  function renderForm(el, form) {
    var fields = form.fields || [];
    var html = '';
    if (form.description) {
      html += '<p class="gw-description">' + escapeHtml(form.description) + '</p>';
    }
    html += '<form id="gw-form-' + form.slug + '" novalidate>';

    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var req = f.required ? ' required' : '';
      var reqMark = f.required ? '<span class="gw-required">*</span>' : '';
      html += '<div class="gw-field">';
      html += '<label for="gw-' + f.id + '">' + escapeHtml(f.label) + reqMark + '</label>';

      if (f.type === 'textarea') {
        html += '<textarea id="gw-' + f.id + '" name="' + f.id + '" placeholder="' + escapeAttr(f.placeholder || '') + '"' + req + '></textarea>';
      } else if (f.type === 'select' && f.options) {
        html += '<select id="gw-' + f.id + '" name="' + f.id + '"' + req + '>';
        html += '<option value="">' + escapeHtml(f.placeholder || 'Select...') + '</option>';
        for (var j = 0; j < f.options.length; j++) {
          html += '<option value="' + escapeAttr(f.options[j]) + '">' + escapeHtml(f.options[j]) + '</option>';
        }
        html += '</select>';
      } else if (f.type === 'checkbox' && f.options) {
        html += '<div class="gw-checkbox-group">';
        for (var j = 0; j < f.options.length; j++) {
          var cbId = 'gw-' + f.id + '-' + j;
          html += '<label class="gw-checkbox-item"><input type="checkbox" id="' + cbId + '" name="' + f.id + '" value="' + escapeAttr(f.options[j]) + '"> ' + escapeHtml(f.options[j]) + '</label>';
        }
        html += '</div>';
      } else if (f.type === 'radio' && f.options) {
        html += '<div class="gw-radio-group">';
        for (var j = 0; j < f.options.length; j++) {
          var rbId = 'gw-' + f.id + '-' + j;
          html += '<label class="gw-radio-item"><input type="radio" id="' + rbId + '" name="' + f.id + '" value="' + escapeAttr(f.options[j]) + '"' + req + '> ' + escapeHtml(f.options[j]) + '</label>';
        }
        html += '</div>';
      } else {
        var inputType = f.type || 'text';
        if (['text', 'email', 'number', 'date', 'tel', 'url', 'phone'].indexOf(inputType) === -1) inputType = 'text';
        if (inputType === 'phone') inputType = 'tel';
        html += '<input type="' + inputType + '" id="gw-' + f.id + '" name="' + f.id + '" placeholder="' + escapeAttr(f.placeholder || '') + '"' + req + '>';
      }

      html += '</div>';
    }

    var btnText = (form.settings && form.settings.submitButtonText) || 'Submit';
    html += '<button type="submit">' + escapeHtml(btnText) + '</button>';
    html += '</form>';

    el.innerHTML = html;

    // Handle submit
    var formEl = document.getElementById('gw-form-' + form.slug);
    formEl.addEventListener('submit', function(e) {
      e.preventDefault();
      var btn = formEl.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.textContent = 'Submitting...';

      var responses = {};
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (f.type === 'checkbox' && f.options) {
          var checked = [];
          var checkboxes = formEl.querySelectorAll('input[name="' + f.id + '"]:checked');
          for (var j = 0; j < checkboxes.length; j++) checked.push(checkboxes[j].value);
          responses[f.id] = checked;
        } else {
          var input = formEl.querySelector('[name="' + f.id + '"]');
          if (input) responses[f.id] = input.type === 'radio' ? (formEl.querySelector('input[name="' + f.id + '"]:checked') || {}).value || '' : input.value;
        }
      }

      fetch(API_BASE + '/api/modules/forms/' + form.slug + '/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ responses: responses, source: 'embed' })
      })
      .then(function(r) { return r.json(); })
      .then(function(result) {
        if (result.success) {
          el.innerHTML = '<div class="gw-thank-you"><h3>' + escapeHtml(form.thank_you_message || 'Thank you!') + '</h3></div>';
        } else {
          btn.disabled = false;
          btn.textContent = btnText;
          alert(result.error || 'Submission failed. Please try again.');
        }
      })
      .catch(function() {
        btn.disabled = false;
        btn.textContent = btnText;
        alert('Submission failed. Please try again.');
      });
    });
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }
  function escapeAttr(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
})();
`;

    return res.send(script.trim());
  });
}
