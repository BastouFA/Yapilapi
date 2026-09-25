-- 007: Canonical interest topics (reference data, not sample data). Safe to re-run semantics via ON CONFLICT.
INSERT INTO topics (slug, name) VALUES
  ('technology','Technology'),('cybersecurity','Cybersecurity'),('business','Business'),('entrepreneurship','Entrepreneurship'),
  ('finance','Finance & Investing'),('education','Education'),('science','Science'),('health','Health & Wellness'),
  ('fitness','Fitness'),('food','Food & Cooking'),('travel','Travel'),('music','Music'),('film-tv','Film & TV'),
  ('gaming','Gaming'),('sports','Sports'),('football','Football'),('fashion','Fashion'),('beauty','Beauty'),
  ('art','Art & Design'),('photography','Photography'),('writing','Writing & Books'),('comedy','Comedy'),
  ('news','News & Current Affairs'),('politics','Politics'),('faith','Faith & Spirituality'),('parenting','Parenting & Family'),
  ('pets','Pets & Animals'),('nature','Nature & Outdoors'),('cars','Cars & Mobility'),('home-garden','Home & Garden'),
  ('careers','Careers & Work'),('startups','Startups'),('languages','Languages & Culture'),('local-events','Local Events'),
  ('diy-crafts','DIY & Crafts'),('mental-health','Mental Health')
ON CONFLICT (slug) DO NOTHING;
