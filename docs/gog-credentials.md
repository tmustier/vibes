# Gog credentials on a Mac

For `/onboard` and existing setups. Gog keeps OAuth client metadata in its per-user `credentials.json`. Refresh tokens and, on newer versions, the OAuth client secret are stored in the keyring. Use gog's encrypted **file** keyring for the tokens so Homebrew upgrades of an ad-hoc-signed `gog` binary do not cause repeated macOS Keychain access dialogs. This setting affects gog, not Pi's model logins, GitHub CLI or MCP connector credentials.

## New setup

1. Install gog and configure the user's own Desktop OAuth client as described in `/onboard`. Before `gog auth add`, choose a strong, persistent keyring password. Never put its value in the repo, command arguments, logs or chat. A per-user private file is one way to make it available without prompts:

   ```bash
   install -d -m 700 "$HOME/.config/gogcli"
   test ! -e "$HOME/.config/gogcli/keyring-password" && \
     (umask 077; openssl rand -hex 32 > "$HOME/.config/gogcli/keyring-password")
   ```

   The 32-byte random password is an agent default, not a user rule. If the user already has a password for gog's file keyring, **reuse it**; replacing it will lock out the existing tokens. This password file is plaintext and protected by local file permissions, not by Keychain. Keep it out of backups or sharing paths that the user has not approved.

2. Make the password available to **every process that runs gog**, including Pi and any background launcher. For a zsh-based interactive setup, add this line once to `~/.zshenv` (or to the user's existing private secrets file sourced from it), then start a new shell:

   ```zsh
   export GOG_KEYRING_PASSWORD="$(/bin/cat "$HOME/.config/gogcli/keyring-password")"
   ```

   If Pi or gog starts from launchd or another process that does not run zsh, configure that launcher to load the same private password without printing it. Do not assume `~/.zshenv` reaches GUI or unattended processes. Verify presence with `test -n "$GOG_KEYRING_PASSWORD"` in the actual runtime; never echo the value.

3. Run `gog auth keyring file`, then `gog auth add <user@example.com>` with the required services. Check `gog auth keyring` reports `file`, `gog auth list --json` lists the account, and make a real read with gog. The `gws` wrapper reuses gog's credentials; run its doctor after setup.

## Existing Keychain-backed account

Do not switch backends and assume the tokens moved. First check `gog auth keyring` and `gog auth list --json` without printing tokens. If the backend is already `file`, do not regenerate its password or migrate it.

For each existing account (and its named client, if any), use gog's [token export](https://github.com/openclaw/gogcli/blob/main/docs/commands/gog-auth-tokens-export.md) and [import](https://github.com/openclaw/gogcli/blob/main/docs/commands/gog-auth-tokens-import.md) commands. They handle **plaintext refresh-token files**: use a private temporary directory with `umask 077`, pass `--out` rather than writing the token to stdout, do not open or log the export, and remove it immediately after successful import. A Keychain access dialog during this *one-time export* may still need approval.

1. Set up the persistent file-keyring password as above. Keep the old Keychain tokens in place for rollback.
2. While the Keychain backend is selected, run `gog auth tokens export <email> --out <private-temp-file>` (add `--client <name>` for a named client). Check the command succeeded; never paste the file contents.
3. Check whether the OAuth client secret also needs migration. A `credentials.json` containing only `client_id` relies on a keyring-held secret. Preserve the original downloaded Desktop OAuth client JSON, or recover the existing secret privately before switching. For the default client, the macOS Keychain item uses service `gogcli` and account `client/default/client-secret`. Use the corresponding name for a named client and respect any configured service-name override. Keep recovered values in private temporary files; never print them or put them in command arguments.
4. Run `gog auth keyring file` and `gog auth tokens import <private-temp-file>`. If the client secret was Keychain-backed, run `gog auth credentials set <private-client-json>` under the file backend too. Use the same OAuth client ID and secret. Repeat for other accounts and clients, explicitly selecting the Keychain backend for each export and the file backend for each import. Delete each temporary export after successful import.
5. Verify `gog auth doctor --check --json --no-input` and a real, read-only gog command for every migrated account, from the same shell or launcher that runs Pi. A readable token alone does not prove that its client secret is available or refresh works. Check `gws` too if used. If migration fails, switch back to the previous backend without deleting the original Keychain entries. Only consider deleting old entries after all reads succeed and the user explicitly wants that cleanup.

An export failing over SSH does not prove the token is missing. Try the export in the user's logged-in desktop session first; a temporary LaunchAgent in their GUI domain can run it without opening Terminal. Keep temporary jobs and files private, and unload and remove them afterwards.

If the token cannot be recovered or Google rejects it, `gog auth add <email>` under the file backend can authorize afresh. Preserve the existing service scopes. Do not ask for another Google sign-in when the existing token and client secret can be migrated.

## Why this is gog-specific

In September 2026, a Homebrew gog 0.42.0 install was observed with `Signature=adhoc` and no `TeamIdentifier`. macOS can ask again for Keychain access when an ad-hoc-signed binary changes. This is not a Google OAuth consent prompt. Gog's file backend avoids that executable-trust issue but requires the password in the runtime environment. Follow each other tool's own supported credential storage rather than imposing this backend on Pi, `gh` or MCP servers.
