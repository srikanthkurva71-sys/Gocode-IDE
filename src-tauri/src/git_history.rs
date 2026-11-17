use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct GitCommit {
    hash: String,
    short_hash: String,
    author: String,
    authored_at: String,
    subject: String,
}

pub fn parse_git_history(output: &str) -> Result<Vec<GitCommit>, String> {
    let mut commits = Vec::new();
    for record in output.split('\x1e') {
        let record = record.trim_matches('\n');
        if record.is_empty() { continue; }
        let fields: Vec<&str> = record.split('\0').collect();
        if fields.len() != 5 {
            return Err("Git returned a malformed history record.".into());
        }
        let hash = fields[0];
        let short_hash = fields[1];
        if !(hash.len() == 40 || hash.len() == 64)
            || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            || short_hash.is_empty()
            || short_hash.len() > 16
            || !short_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Git returned an invalid commit identifier.".into());
        }
        if fields[2].len() > 200 || fields[3].len() > 80 || fields[4].len() > 500 {
            return Err("Git returned a history field that exceeds its size limit.".into());
        }
        commits.push(GitCommit {
            hash: hash.to_ascii_lowercase(),
            short_hash: short_hash.to_string(),
            author: fields[2].to_string(),
            authored_at: fields[3].to_string(),
            subject: fields[4].to_string(),
        });
        if commits.len() > 50 {
            return Err("Git history exceeded the 50-commit response limit.".into());
        }
    }
    Ok(commits)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
        fn parses_nul_delimited_history_records() {
            let hash = "a".repeat(40);
            let output = format!("{hash}\0abc1234\0A Developer\02026-11-16T12:00:00+05:30\0Add history\x1e\n");
            let commits = parse_git_history(&output).expect("valid history should parse");
            assert_eq!(commits.len(), 1);
            assert_eq!(commits[0].hash, hash);
            assert_eq!(commits[0].author, "A Developer");
            assert_eq!(commits[0].subject, "Add history");
        }
    
        #[test]
        fn rejects_malformed_or_untrusted_commit_identifiers() {
            assert!(parse_git_history("not-a-hash\0bad\0Author\0date\0subject\x1e").is_err());
            assert!(parse_git_history("abc\0abc\0Author\0date\0subject\x1e").is_err());
        }
    
        #[test]
        fn rejects_oversized_history_fields_and_more_than_fifty_commits() {
            let hash = "b".repeat(40);
            let oversized = format!("{hash}\0abc1234\0{}\0date\0subject\x1e", "x".repeat(201));
            assert!(parse_git_history(&oversized).is_err());
            let record = format!("{hash}\0abc1234\0Author\0date\0subject\x1e");
            assert!(parse_git_history(&record.repeat(51)).is_err());
        }
}
