# Mekka CLI

Run Mekka with one command:

```sh
npx mekka
```

With Bun already installed, this creates a `mekka` directory, installs every dependency, and starts
the complete local backend and Studio at `http://127.0.0.1:8082`.

Choose a different directory:

```sh
npx mekka my-app
```

Prepare the project without starting it:

```sh
npx mekka my-app --no-start
```

Requires Node.js 20 or newer, Bun 1.3.14 or newer, and Git. If Bun is missing, the CLI stops before
downloading anything and prints the exact official installation command for the current platform.

Mekka is built in public under the Mekka Business License 2.0. The license gives qualifying small
organizations room to build while preventing third parties from repackaging Mekka as a competing
hosted backend or cloud service without a commercial agreement.
