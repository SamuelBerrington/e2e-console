# Security

## What the console is, and is not

E2E Console is a local developer tool. It listens on `127.0.0.1` only, has no login, and by design runs programs
on your machine (adb, the emulator, Maestro, a browser, `kubectl`, a login plugin you point it at). Its settings
hold API tokens. Do not expose it to a network, put it behind a proxy or run it on a shared server.

Protections that are in place and are meant to hold:

- requests are answered only for `127.0.0.1` / `localhost` on the console's own port (the `Host` header is checked);
- API requests from pages of other origins are refused (`Origin`, `Sec-Fetch-Site`), and a request body must be
  `application/json`, so another website open in your browser cannot drive the console;
- the export "without keys" contains no tokens, phone numbers, one-time codes, machine paths or device serials;
- run variables never reach a shell command line when a run goes through Maestro;
- text from scenarios, runs and imported files is escaped before it is shown in the UI.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting instead: the **Security** tab of the
repository, then **Report a vulnerability**. Describe what an attacker can do, the steps to reproduce it and the
version or commit you tested.

Things worth reporting: a web page or a file that makes the console run a program, read or send tokens, or
change settings without the user's action; a way around the `Host` / `Origin` checks; secrets leaking into an
export, a log or a screenshot; script injection in the UI.

Not vulnerabilities: anything that requires the attacker to already run code as your user, to edit
`data/settings.json`, or to have been given the address of a console that someone exposed to a network against
the advice above.

There is no bounty. You will get an answer, and credit in the release notes if you want it.

## Supported versions

Only the latest release and the `main` branch receive fixes.
