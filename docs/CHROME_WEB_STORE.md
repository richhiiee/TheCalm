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

A later store release is a separate workflow:

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

## Publish CalmSkip 0.1.5

The prepared release is **public and searchable**. It includes the original mint/teal skip icon and the actual extension interface in clearly labeled demonstration screenshots. These assets do not claim that the demonstration video is a playable episode from TheCalm.

Stop an existing watcher with **Ctrl+C** before pulling, because the rename also updates its compatibility checks. Then create the upload ZIP using Windows PowerShell; Node.js and Python are unnecessary for this step:

```powershell
Set-Location "$HOME\source\TheCalm"
git pull --ff-only
Compress-Archive -Path .\extension\* -DestinationPath "$HOME\Downloads\CalmSkip-0.1.5.zip" -Force
```

The ZIP must contain `manifest.json` at its root, alongside the extension scripts and `icons` folder. Upload **CalmSkip-0.1.5.zip** from Downloads using **Add new item** in the developer dashboard.

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

After the actual dashboard fields, assets, account verification, and reviewer access are complete, use **Submit for review**. Google decides approval and publication timing. The cloud tools cannot operate your signed-in developer dashboard, so creating this release package does not upload or submit the item.

To resume local development afterward, use the watch command in [the Windows development guide](DEVELOPMENT_WINDOWS.md#upgrading-the-name-to-calmskip). Keep one enabled extension copy when testing the store build.

## Official references

- [Register your developer account](https://developer.chrome.com/docs/webstore/register)
- [Set up your developer account](https://developer.chrome.com/docs/webstore/set-up-account)
- [2-Step Verification requirement](https://developer.chrome.com/docs/webstore/program-policies/two-step-verification)
- [Distribution and visibility](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)
- [Publish in the Chrome Web Store](https://developer.chrome.com/docs/webstore/publish)
- [Brave: adding extensions](https://support.brave.com/hc/en-us/articles/360017909112-How-can-I-add-extensions-to-Brave)

The account requirements and links above were checked against the official documentation on October 28, 2026. Follow any additional account or verification prompts shown by Google for your circumstances.
