# feature-parser — SPEC (NEW, deterministic)
Input: a source suite root. Output: a JSON model of every .feature file.
Parse each .feature into: { file, feature, background?, scenarios:[ { name, tags[],
steps:[ {keyword, text} ], examples?:[ {..cols..} ] } ] }.
Rules: handle Feature/Background/Scenario/Scenario Outline/Examples; keep And/But as their literal
keyword (binding decides the effective Given/When/Then); preserve step text EXACTLY (params in place).
No LLM. ~150 lines Node. Tested standalone on saipradeepcs .feature files.
