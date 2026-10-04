# Changelog

## 0.2.2

- Fix Linux user-service installation by writing WorkingDirectory as a literal path.
- Verify generated units with systemd's parser on Linux, including paths containing spaces and percent signs.

## 0.2.1

- Publish the source on GitHub and add Linux/macOS CI with the locked Python runtime.
- Add tag-triggered npm publishing with GitHub OIDC and provenance.
- Document npm installation into a stable user directory for persistent services.

## 0.2.0

- Wrap official Filesystem, Fetch, Git, Memory, Sequential Thinking and Time MCP servers for DreamMate.
- Add namespace/session isolation, scoped Git repositories, public-address Fetch proxy and user service installation.
