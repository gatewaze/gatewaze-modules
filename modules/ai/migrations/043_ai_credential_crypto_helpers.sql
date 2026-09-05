-- ai module — 043: the pgsodium credential helpers the credential paths have
-- always referenced but no migration ever defined (per-use-case/user
-- credential rows could never be written or read on any deployment).
--
-- Contract (matches lib/credentials.ts + api/admin-routes.ts):
--   pgsodium_encrypt_text(p_plaintext) → jsonb {ciphertext:'\x…', nonce:'\x…'}
--     ('\x'-prefixed hex: PostgREST stores it into bytea columns verbatim)
--   pgsodium_decrypt_text(p_ciphertext, p_nonce) → text
--     (accepts hex with or without the '\x' prefix)
-- Key material lives only inside Postgres (pgsodium server-managed key).

do $$ begin
  if not exists (select 1 from pgsodium.valid_key where name = 'gatewaze_ai_credentials') then
    perform pgsodium.create_key(name => 'gatewaze_ai_credentials');
  end if;
end $$;

create or replace function public.pgsodium_encrypt_text(p_plaintext text)
returns jsonb
language plpgsql
security definer
set search_path = public, pgsodium
as $$
declare
  k uuid;
  n bytea;
  c bytea;
begin
  select id into k from pgsodium.valid_key where name = 'gatewaze_ai_credentials' limit 1;
  n := pgsodium.crypto_aead_ietf_noncegen();
  c := pgsodium.crypto_aead_ietf_encrypt(convert_to(p_plaintext, 'utf8'), ''::bytea, n, k);
  return jsonb_build_object(
    'ciphertext', '\x' || encode(c, 'hex'),
    'nonce', '\x' || encode(n, 'hex')
  );
end $$;

create or replace function public.pgsodium_decrypt_text(p_ciphertext text, p_nonce text)
returns text
language plpgsql
security definer
set search_path = public, pgsodium
as $$
declare
  k uuid;
begin
  select id into k from pgsodium.valid_key where name = 'gatewaze_ai_credentials' limit 1;
  return convert_from(
    pgsodium.crypto_aead_ietf_decrypt(
      decode(replace(p_ciphertext, '\x', ''), 'hex'),
      ''::bytea,
      decode(replace(p_nonce, '\x', ''), 'hex'),
      k
    ), 'utf8');
end $$;

revoke all on function public.pgsodium_encrypt_text(text) from public;
revoke all on function public.pgsodium_decrypt_text(text, text) from public;
grant execute on function public.pgsodium_encrypt_text(text) to service_role;
grant execute on function public.pgsodium_decrypt_text(text, text) to service_role;
