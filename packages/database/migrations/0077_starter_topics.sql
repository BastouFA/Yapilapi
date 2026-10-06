-- Starter topics for choosing interests, on every database (until now only the development seed
-- made any, so a new site asked people what they're into and offered nothing). Names are English;
-- the apps show each one in the reader's language (topic.<slug> in the catalogs).
INSERT INTO topics (slug, name) VALUES
  ('music', 'Music'),
  ('afrobeats', 'Afrobeats'),
  ('football', 'Football'),
  ('basketball', 'Basketball'),
  ('fashion', 'Fashion'),
  ('beauty', 'Beauty'),
  ('food', 'Food'),
  ('cooking', 'Cooking'),
  ('travel', 'Travel'),
  ('photography', 'Photography'),
  ('art', 'Art'),
  ('design', 'Design'),
  ('film', 'Film and TV'),
  ('books', 'Books'),
  ('gaming', 'Gaming'),
  ('technology', 'Technology'),
  ('business', 'Business'),
  ('fitness', 'Fitness'),
  ('comedy', 'Comedy'),
  ('dance', 'Dance'),
  ('faith', 'Faith'),
  ('nature', 'Nature'),
  ('science', 'Science'),
  ('education', 'Education')
ON CONFLICT (slug) DO NOTHING;
