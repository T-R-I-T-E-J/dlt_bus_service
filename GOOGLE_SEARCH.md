# Google Search setup

The canonical site is `https://dltservices.tech/`. Google Search Console's
Domain property is `sc-domain:dltservices.tech`, managed through the account
selected by the operator (`info@triomavtech.com`). Ownership was verified by
adding Google's TXT record at the apex alongside the existing verification
records. Keep that TXT record in DNS to retain verification.

Submitted sitemap: `https://dltservices.tech/sitemap.xml`. Submission was
accepted, but its initial report showed "Couldn't fetch" with no last-read
date. Both ordinary and Googlebot user-agent checks from the test host returned
HTTP 200 and well-formed XML. Recheck the sitemap report after deploying this
update; submission alone is not proof of successful processing or indexing.

The sitemap includes Home, Booking and Policies. These pages have one static
title, description, canonical URL and index directive in their document head.
Structured-data URLs use the same apex domain; the public fare remains ₹320.
Account, My Trips and Admin have static `noindex,nofollow` metadata and are
excluded from the sitemap. They remain crawlable so Google can read noindex.
Public API reads are crawlable for rendering departures and return the
`X-Robots-Tag: noindex` header. Authentication and authorization are unchanged.

Update the live frontend without restarting the API or changing credentials:

```sh
git pull --ff-only
bash deploy/vps/update-main-frontend.sh
```

This prepares a new release, validates Nginx and atomically changes the static
symlink, with rollback on a failed health check. Keep sitemap lastmod dates
aligned with actual significant public-page changes. After deployment, inspect
the home and booking URLs in Search Console, test the live URLs and request
indexing. Check sitemap fetch status and discovered pages. Google controls
crawl/index timing and search rankings; neither is guaranteed by submission.
