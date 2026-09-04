# GitHub Pages deployment

The site is static and can be served directly from the repository root.

## Recommended setup

In the GitHub repository:

1. open **Settings → Pages**;
2. under **Build and deployment**, choose **Deploy from a branch**;
3. select branch `main` and folder `/ (root)`;
4. save;
5. wait for the published HTTPS URL to appear.

HTTPS is important because mobile camera access via `getUserMedia()` is restricted to secure contexts, except localhost.

For this repository the expected project-page pattern is:

`https://arigony.github.io/MaleFlyConnectome/`

Do not place neuPrint tokens in GitHub Pages, JavaScript, HTML, workflow logs or committed JSON. Generate scientific subsets offline and commit only the resulting source-traceable data when appropriate.
