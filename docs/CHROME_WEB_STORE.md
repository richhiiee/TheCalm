# Chrome Web Store account setup

The development setup works before you register a store account. During testing, use the [Windows development sync guide](DEVELOPMENT_WINDOWS.md) to update the unpacked extension in Brave. Store registration is for publishing a version that Brave can install and update through the Chrome Web Store.

## Register your developer account

1. Choose the Google account you intend to keep for publishing. Google's registration guide says the developer-account email cannot be changed after creation.
2. Enable [Google 2-Step Verification](https://myaccount.google.com/security/signinoptions/two-step-verification/enroll-welcome). Google requires it before publishing or updating extensions.
3. Open the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/) and sign in with that account.
4. Accept the developer agreement and policies, then pay the **one-time registration fee shown by Google**. The current registration documentation does not specify a fixed amount, so use the fee displayed in the dashboard.
5. Open **Account**, set your required **Publisher name**, add your contact email, and follow its verification link. Use the account and contact details you want associated with the extension.

Complete sign-in, verification codes, and payment directly on Google's pages. No account password, verification code, payment details, or API key needs to be added to this repository or the extension.

When you can access the developer dashboard with a verified contact email, the account setup is complete. Creating the account does not submit or publish an extension.

## Development updates and store updates

The unpacked extension remains the development version:

- The local sync script copies extension source files into your existing installed folder, preserving backups.
- After a change, click **Reload** for CalmSkip in `brave://extensions`, then reopen the episode. An unpacked extension does not automatically reload when its files change.
- The store account is not used by the sync script. Development updates do not require a store review.

A first store release is a separate workflow:

1. Run the tests and package command from the repository, or download the package artifact from a passing **Checks** run in GitHub Actions. Extract the downloaded artifact and use the contained `thecalm-skip.zip` for the store upload.
2. Prepare the store listing assets, screenshots, description, privacy disclosures, and testing instructions. The existing development ZIP is not proof that those submission requirements are complete.
3. In the dashboard, choose **Add new item**, upload the extension ZIP, complete the listing and privacy fields, and select its distribution visibility.
4. Submit the item for Google's review. After approval and publication, install that store listing in Brave. Approved subsequent store versions can then update through Brave's normal extension updater.

Choose visibility based on who should be able to install:

| Visibility | Who can install |
| --- | --- |
| **Private** | Designated trusted testers. Useful for a restricted test group. |
| **Unlisted** | Anyone who has the listing URL. It does not appear in store search, but the link is not access control. |
| **Public** | Users who find the listing through search or its URL. |

All visibility options still undergo Google's review. Do not expect an unlisted or private submission to appear immediately.

Brave supports installing Chrome Web Store extensions through the listing's **Add to Brave** button. Once the store version is installed, disable the unpacked development copy when using the store version so two copies do not operate on the same player.

## Update the existing listing to 0.1.6

[CalmSkip is public](https://chromewebstore.google.com/detail/calmskip/ffikdfibljniiabnkgpihdpdhheammlo) at **v0.1.5**. Version **0.1.6** adds automatic series identification beyond Prison Break, show-match selection and correction, and clearer missing-timestamp status. A GitHub push or local sync does not update the store: upload the new ZIP to the **existing item**, then submit that update for review.

Stop an existing watcher with **Ctrl+C** before pulling. In the Windows `development` checkout, create the upload ZIP using PowerShell; Node.js and Python are unnecessary for this step:

```powershell
Set-Location "$HOME\source\TheCalm"
git pull --ff-only
Get-Content .\extension\manifest.json | ConvertFrom-Json | Select-Object name, version
Compress-Archive -Path .\extension\* -DestinationPath "$HOME\Downloads\CalmSkip-0.1.6.zip" -Force
```

Confirm the version output is **0.1.6**. The ZIP must contain `manifest.json` at its root, alongside the extension scripts and `icons` folder.

1. Open the [existing CalmSkip dashboard item](https://chrome.google.com/webstore/devconsole/ab89a478-5b96-48cb-a4d0-1d83c227760c/ffikdfibljniiabnkgpihdpdhheammlo/edit/package).
2. Under **Package**, choose **Upload new package**, select **CalmSkip-0.1.6.zip** from Downloads, and confirm the draft package version.
3. Refresh the listing description and screenshots from the files below. In **Privacy**, update the `storage` and IntroDB host explanations to include the title lookup and local show-match cache, using [the submission fields](store/SUBMISSION.md). The data categories, privacy policy URL, and **No remote code** answer remain the same. Version 0.1.6 adds no permissions or hosts.
4. Retain working private reviewer access instructions and the **Public** distribution setting. Save the draft, then choose **Submit for review**. Leave automatic publication after approval enabled if you want the update released as soon as Google approves it.

The public 0.1.5 listing stays available while Google reviews the update. After 0.1.6 is published, store-installed copies receive it through the browser's normal extension updater; unpacked copies still need their usual sync and reload. Uploading to this existing item preserves its listing URL and users.

The cloud tools cannot operate the signed-in developer dashboard. Preparing this package does not upload, submit, or publish 0.1.6.

## Listing assets and reviewer access

The release is **public and searchable**. It includes the original mint/teal skip icon and the actual extension interface in clearly labeled demonstration screenshots. These assets do not claim that the demonstration video is a playable episode from TheCalm.

Complete the listing with these files from the checkout:

| Dashboard field | File or value |
| --- | --- |
| Name and descriptions | [store/LISTING.md](store/LISTING.md) |
| Store icon | `docs/store/assets/icon-128.png` |
| Screenshots, 1280×800 | `docs/store/assets/screenshot-01-automatic-skip.png` and `screenshot-02-next-episode.png` |
| Privacy policy URL | `https://github.com/richhiiee/TheCalm/blob/development/docs/store/PRIVACY.md` |
| Single purpose, permission reasons, data disclosures, review steps | [store/SUBMISSION.md](store/SUBMISSION.md) |
| Visibility | **Public** |

TheCalm’s playable pages require a signed-in session. Enter working reviewer access instructions privately in Google’s **Test instructions** field before submitting. The extension itself has no account; this release has not created or verified a separate TheCalm review account.

Google decides approval and publication timing. A new package needs another review even though the first version is already public.

To resume local development afterward, use the watch command in [the Windows development guide](DEVELOPMENT_WINDOWS.md#upgrading-the-name-to-calmskip). Keep one enabled extension copy when testing the store build.

## Official references

- [Register your developer account](https://developer.chrome.com/docs/webstore/register)
- [Set up your developer account](https://developer.chrome.com/docs/webstore/set-up-account)
- [2-Step Verification requirement](https://developer.chrome.com/docs/webstore/program-policies/two-step-verification)
- [Distribution and visibility](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)
- [Publish in the Chrome Web Store](https://developer.chrome.com/docs/webstore/publish)
- [Update an existing Chrome Web Store item](https://developer.chrome.com/docs/webstore/update)
- [Brave: adding extensions](https://support.brave.com/hc/en-us/articles/360017909112-How-can-I-add-extensions-to-Brave)

The account requirements were checked against the official documentation on October 28, 2026; the update workflow and public 0.1.5 listing were checked on October 31, 2026. Follow any additional account or verification prompts shown by Google for your circumstances.
