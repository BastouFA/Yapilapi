-- Why an admin didn't approve a Mini App, when they said. The developer sees it on the developers page
-- and in the notification; approving clears it.
ALTER TABLE mini_apps ADD COLUMN review_reason text CHECK (char_length(review_reason) <= 2000);
